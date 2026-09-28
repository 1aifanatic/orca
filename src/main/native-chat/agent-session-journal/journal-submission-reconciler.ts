// Restart reconciliation for the crash boundary.
//
// A submission row is durable before dispatch, so after a crash the host knows
// what it TRIED to send but not whether the provider took it. Every surviving
// `pending` becomes `unknown` and is then matched against provider history.
//
// A send handed over under an id the provider adopts is decided by that id alone,
// looked up across the whole history: present means delivered, absent from a
// history read whole means not — unless a copy of its text no other send's id
// accounts for could be it. Older sends carry no such id and fall back to
// the anchored window — an echoed client message id, else a provider item id the
// journal already adopted, else the payload fingerprint when it picks out
// exactly one unclaimed item. That window is not scoped to the send, so absence
// from it proves nothing and those sends stay `unknown`. Never by text equality:
// the same question asked twice is two messages, and collapsing them loses one.
//
// Orca never re-sends on the user's behalf. An unresolved submission stays
// `unknown` — a displayed state meaning "delivery unconfirmed", neither sent nor
// failed — and the user chooses to resend or discard.

import type {
  AgentJournalItemIdentity,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { DISPATCH_REJECTED_NOT_DELIVERED } from '../../../shared/structured-agent-session-dispatch-rejection'

export type ProviderHistoryItem = {
  /** The provider's own id for this item. Used to claim it at most once; the
   *  journal key comes from `identity`, because a provider id is not stable. */
  providerItemId: string
  /** The client message id when the provider echoes one (Codex carries it on
   *  user messages); null for providers that drop it. */
  clientMessageId: string | null
  /** Fingerprint of the submitted payload, when the caller can compute one from
   *  provider content. Used only to break an otherwise unique tie. */
  payloadFingerprint: string | null
  identity: AgentJournalItemIdentity
}

export type ProviderHistoryWindow = {
  /** Provider items observed at or after the journal's last committed item. */
  items: readonly ProviderHistoryItem[]
  /**
   * The history read actually started at the journal's last committed item. A
   * fork, a compacted provider log, or a truncated read makes absence
   * meaningless, so a missing submission cannot be called "not delivered".
   */
  boundaryConsistent: boolean
  /** The provider reports a turn still running: absence proves nothing yet. */
  turnInFlight: boolean
  /** Every user item the history holds, not only those after the anchor. Absent when the
   *  provider has no whole-history read; sends handed over under an id then stay `unknown`. */
  recorded?: ProviderRecordedHistory | null
}

export type ProviderRecordedHistory = {
  /** Journal keys of every user item in the history. */
  itemIds: ReadonlySet<string>
  /** Keys of the items holding each text block, once per copy, by that block's payload
   *  fingerprint. A send recorded under an id Orca did not choose, or merged into another send's
   *  item, leaves only its text behind, so a copy no send found by id accounts for vetoes absence. */
  itemIdsByFingerprint: ReadonlyMap<string, readonly string[]>
  /** The history was read whole and is where an item with this key would have been recorded. */
  provesAbsenceOf: (itemId: string) => boolean
}

/**
 * Provider history as an attach samples it. Liveness is fixed at the sample, before a new child
 * starts; each read runs only when an unsettled send is decided by it, so an open with nothing to
 * decide reads no transcript. A read that fails leaves its sends `unknown`.
 */
export type ProviderHistorySource = {
  turnInFlight: boolean
  /** The anchored window: only sends handed over with no id are decided by it. */
  readWindow: () => Promise<Pick<ProviderHistoryWindow, 'items' | 'boundaryConsistent'>>
  /** Every recorded user item: only sends handed over under an id are decided by it. */
  readRecorded: () => Promise<ProviderRecordedHistory | null>
}

export type SubmissionReconciliation =
  | {
      clientMessageId: string
      outcome: 'accepted'
      providerItemId: string
      identity: AgentJournalItemIdentity
    }
  | { clientMessageId: string; outcome: 'rejected'; reason: SubmissionRejectionReason }
  | { clientMessageId: string; outcome: 'unknown'; reason: SubmissionUnknownReason }

export type SubmissionRejectionReason = typeof DISPATCH_REJECTED_NOT_DELIVERED

export type SubmissionUnknownReason =
  | 'history_boundary_inconsistent'
  | 'turn_in_flight'
  | 'ambiguous_match'
  | 'no_dispatch_identity'

/**
 * Resolve every unsettled submission against provider history.
 *
 * Passes run strongest-first across ALL submissions before the next begins, so
 * a weak fingerprint tie can never claim an item that an echoed client message
 * id would have matched exactly. Each history item is claimable once.
 */
export function reconcileSubmissions(input: {
  submissions: readonly AgentJournalSubmission[]
  history: ProviderHistoryWindow
}): SubmissionReconciliation[] {
  const unsettled = input.submissions.filter(
    (submission) => submission.dispatchState === 'pending' || submission.dispatchState === 'unknown'
  )
  const recorded = input.history.recorded
  const identified = new Set(
    unsettled.flatMap(({ handedOverItemId: id }) => (id && recorded?.itemIds.has(id) ? [id] : []))
  )
  const legacy = unsettled.filter((submission) => !submission.handedOverItemId)
  const items = input.history.items.filter(
    (item) => !identified.has(agentJournalItemKey(item.identity))
  )
  const claimed = new Set<string>()
  const matched = new Map<string, ProviderHistoryItem>()
  const ambiguous = new Set<string>()

  claimBy(
    legacy,
    items,
    claimed,
    matched,
    (submission, item) =>
      // A submission that already adopted a key re-matches on that key, not on the
      // provider's raw id — the raw id renumbers, the identity-derived key does not.
      Boolean(submission.providerItemId) &&
      submission.providerItemId === agentJournalItemKey(item.identity)
  )
  claimBy(
    legacy,
    items,
    claimed,
    matched,
    (submission, item) =>
      Boolean(item.clientMessageId) && item.clientMessageId === submission.clientMessageId
  )

  // Resolve fingerprint candidates as a batch. Assigning the sole candidate to
  // the first identical submission would make the later one look absent even
  // though either submission could be the delivered one.
  const submissionsByFingerprint = new Map<string, AgentJournalSubmission[]>()
  for (const submission of legacy) {
    if (matched.has(submission.clientMessageId) || !submission.payloadFingerprint) {
      continue
    }
    const sameFingerprint = submissionsByFingerprint.get(submission.payloadFingerprint) ?? []
    sameFingerprint.push(submission)
    submissionsByFingerprint.set(submission.payloadFingerprint, sameFingerprint)
  }
  for (const [fingerprint, fingerprintSubmissions] of submissionsByFingerprint) {
    const candidates = items.filter(
      (item) => !claimed.has(item.providerItemId) && item.payloadFingerprint === fingerprint
    )
    if (fingerprintSubmissions.length === 1 && candidates.length === 1) {
      const [submission] = fingerprintSubmissions
      const [only] = candidates
      claimed.add(only!.providerItemId)
      matched.set(submission!.clientMessageId, only!)
      continue
    }
    if (candidates.length > 0) {
      // Equal payloads without an id cannot be assigned safely, including when
      // fewer provider items exist than unsettled submissions.
      for (const submission of fingerprintSubmissions) {
        ambiguous.add(submission.clientMessageId)
      }
    }
  }

  const unclaimed = unclaimedCopies(recorded, unsettled, identified)
  return unsettled.map((submission) =>
    submission.handedOverItemId
      ? resolveByIdentity(
          submission,
          submission.handedOverItemId,
          identified,
          unclaimed,
          input.history
        )
      : resolveOne(submission, matched, ambiguous, input.history)
  )
}

/** Copies of each text left once every send found by its id takes its own: a leftover copy may be
 *  a send whose id the history does not hold. */
function unclaimedCopies(
  recorded: ProviderRecordedHistory | null | undefined,
  submissions: readonly AgentJournalSubmission[],
  identified: ReadonlySet<string>
): Map<string, number> {
  const copies = new Map(
    [...(recorded?.itemIdsByFingerprint ?? [])].map(([key, itemIds]) => [key, [...itemIds]])
  )
  for (const submission of submissions) {
    const own = submission.handedOverItemId
    const sameText =
      own && identified.has(own) ? copies.get(submission.payloadFingerprint) : undefined
    if (own && sameText?.includes(own)) {
      sameText.splice(sameText.indexOf(own), 1)
    }
  }
  return new Map([...copies].map(([key, itemIds]) => [key, itemIds.length]))
}

function resolveByIdentity(
  submission: AgentJournalSubmission,
  itemId: string,
  identified: ReadonlySet<string>,
  unclaimed: ReadonlyMap<string, number>,
  history: ProviderHistoryWindow
): SubmissionReconciliation {
  const { clientMessageId } = submission
  if (identified.has(itemId)) {
    const identity = parseAgentJournalItemKey(itemId)
    return identity
      ? { clientMessageId, outcome: 'accepted', providerItemId: itemId, identity }
      : { clientMessageId, outcome: 'unknown', reason: 'history_boundary_inconsistent' }
  }
  if (history.turnInFlight) {
    return { clientMessageId, outcome: 'unknown', reason: 'turn_in_flight' }
  }
  if (!history.recorded?.provesAbsenceOf(itemId)) {
    return { clientMessageId, outcome: 'unknown', reason: 'history_boundary_inconsistent' }
  }
  if ((unclaimed.get(submission.payloadFingerprint) ?? 0) > 0) {
    return { clientMessageId, outcome: 'unknown', reason: 'ambiguous_match' }
  }
  return { clientMessageId, outcome: 'rejected', reason: DISPATCH_REJECTED_NOT_DELIVERED }
}

function claimBy(
  submissions: readonly AgentJournalSubmission[],
  items: readonly ProviderHistoryItem[],
  claimed: Set<string>,
  matched: Map<string, ProviderHistoryItem>,
  matches: (submission: AgentJournalSubmission, item: ProviderHistoryItem) => boolean
): void {
  for (const submission of submissions) {
    if (matched.has(submission.clientMessageId)) {
      continue
    }
    const item = items.find((candidate) => {
      return !claimed.has(candidate.providerItemId) && matches(submission, candidate)
    })
    if (item) {
      claimed.add(item.providerItemId)
      matched.set(submission.clientMessageId, item)
    }
  }
}

function resolveOne(
  submission: AgentJournalSubmission,
  matched: Map<string, ProviderHistoryItem>,
  ambiguous: Set<string>,
  history: ProviderHistoryWindow
): SubmissionReconciliation {
  const item = matched.get(submission.clientMessageId)
  if (item) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'accepted',
      providerItemId: item.providerItemId,
      identity: item.identity
    }
  }
  if (ambiguous.has(submission.clientMessageId)) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'unknown',
      reason: 'ambiguous_match'
    }
  }
  if (!history.boundaryConsistent) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'unknown',
      reason: 'history_boundary_inconsistent'
    }
  }
  if (history.turnInFlight) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'unknown',
      reason: 'turn_in_flight'
    }
  }
  // The anchor is the last completed turn, not this send's hand-over, so the send may sit
  // before it: absence here cannot say the provider never took it.
  return {
    clientMessageId: submission.clientMessageId,
    outcome: 'unknown',
    reason: 'no_dispatch_identity'
  }
}
