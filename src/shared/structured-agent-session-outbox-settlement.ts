// How a desktop chat send ends. Every send ends one of three ways, decided only by what the host
// said, never by a flag this client stored:
//   1. recorded: the host holds a row, a queued card or a hand-off, and from then on the host's row
//      shows the message to every viewer, however it ends (a rejected one's entry draws it until
//      its row loads);
//   2. returned: the host proved it has no record and never will, so the text goes back to the
//      chat's draft and the reason is said once;
//   3. unanswered: nothing proves either, so the same id is sent again until the host answers. The
//      host records an id at most once, so a resend can't deliver twice.
// Pure on purpose: the callers own the outbox, the draft and the chat line.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type { AgentJournalCursor, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import { agentSessionWriteNoticeParts } from './agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from './agent-session-write-notice-copy'
import {
  agentSessionRefusalFailure,
  agentSessionRpcErrorFailure,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'
import {
  AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS,
  parseAgentSessionOperationTimestamp
} from './agent-session-host-authority'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import { DISPATCH_DOUBT_SUBMISSION_MISSING } from './structured-agent-session-unanswered-dispatch'
import { structuredAgentSessionStillSendingWords } from './structured-agent-session-still-sending-words'
import {
  structuredAgentSessionRejectedFailure,
  structuredAgentSessionRejectionAwaitsItsRow,
  type StructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionRecordedRejection
} from './structured-agent-session-outbox'
import { structuredAgentSessionEntryAwaitsSettlement } from './structured-agent-session-outbox-admission'

export type StructuredAgentSessionOutboxSettlement =
  /** Case 1: the host's row (or card) holds the message from here. */
  | { kind: 'recorded' }
  /** Case 1, not final yet: the host wrote the row and has not handed it to the agent. The entry
   *  stays until the row settles, since a Stop may still withdraw it back to this composer. */
  | { kind: 'pending' }
  /** Case 1: the host recorded it and rejected it, and this client has not loaded its row. The
   *  entry keeps the host's fact and draws it, never sent again, until that row loads. */
  | { kind: 'rejectedUnseen'; recorded: StructuredAgentSessionRecordedRejection }
  /** A Stop took it back: the text returns to the draft and nothing is said. */
  | { kind: 'withdrawn' }
  /** Case 2: the text returns to the draft with these words on the chat line. */
  | { kind: 'returned'; words: AgentSessionWriteNoticePart[] }
  /** Case 3: no answer; the same id goes again. `words` say why, once, when what came back was a
   *  refusal Orca can't take as proof, so the person knows what holds the message. */
  | { kind: 'unanswered'; words?: AgentSessionWriteNoticePart[] }

/** What one `agentSession.send` attempt got back. */
export type StructuredAgentSessionSendAnswer =
  | { kind: 'result'; result: AgentSessionMutationResult<AgentSessionSendResult> }
  /** The request threw. Read by its codes, never its message text: the host refusal its error
   *  carried, if any, and the RPC error code. */
  | { kind: 'thrown'; refusal: AgentSessionWriteRefusal | undefined; rpcCode: string | undefined }

export type StructuredAgentSessionOutboxSettlementContext = {
  /** No earlier attempt under this id went out from anywhere, so nothing can hold it but this
   *  attempt. Only an older host needs it: it may refuse a resent id before looking it up. */
  firstAttempt: boolean
  /** The host checks a resent id before anything else, so every refusal it returns proves the id
   *  has no record (`agent-session.send-answers-proof.v1`). */
  answersProve: boolean
  /** The loaded journal holds a row for this id. */
  journalHasRow: boolean
  /** The loaded journal pages hold the message's own row, which draws it. */
  rowLoaded: boolean
  /** The host's window for this id has closed, by the id's own time
   *  (`structuredAgentSessionEntryOutlivedHostWindow`). */
  outlivedHostWindow: boolean
}

/** Words for a message Orca can no longer settle with the host: an earlier attempt may already be
 *  in the chat, so the person checks before sending it again. */
export const STRUCTURED_AGENT_SESSION_SEND_UNCONFIRMED_WORDS: readonly AgentSessionWriteNoticePart[] =
  ['sendOutcomeLost']

function returnedFor(refusal: AgentSessionWriteRefusal): StructuredAgentSessionOutboxSettlement {
  return { kind: 'returned', words: agentSessionWriteNoticeParts(refusal, 'composer-send') }
}

/** Case 3 for a refusal that proves nothing here: why it is held, and that Orca keeps sending it.
 *  "Outcome unknown" is doubt like any lost answer, so it says nothing, thrown or returned. */
function stillSendingFor(
  refusal: AgentSessionWriteRefusal
): StructuredAgentSessionOutboxSettlement {
  return refusal.code === 'agent_session_operation_unknown'
    ? { kind: 'unanswered' }
    : { kind: 'unanswered', words: structuredAgentSessionStillSendingWords(refusal) }
}

/** Words for an id no resend can settle: what an earlier attempt left, if anything, is in the chat. */
function settledByJournal(
  context: StructuredAgentSessionOutboxSettlementContext
): StructuredAgentSessionOutboxSettlement {
  return context.journalHasRow
    ? { kind: 'recorded' }
    : { kind: 'returned', words: [...STRUCTURED_AGENT_SESSION_SEND_UNCONFIRMED_WORDS] }
}

function refusalSettlement(
  refusal: AgentSessionWriteRefusal,
  context: StructuredAgentSessionOutboxSettlementContext
): StructuredAgentSessionOutboxSettlement {
  const reason = refusal.details?.reason
  if (refusal.code === 'agent_session_operation_unknown') {
    // A rewind the host refused before writing anything is settled; every other unknown is doubt.
    return reason === 'rewindUnconfirmed' ? returnedFor(refusal) : { kind: 'unanswered' }
  }
  if (refusal.code === 'agent_session_operation_expired') {
    // The host forgot the id; the journal is what still knows whether it landed.
    return settledByJournal(context)
  }
  if (context.firstAttempt) {
    return returnedFor(refusal)
  }
  if (
    refusal.code === 'agent_session_operation_conflict' ||
    (refusal.code === 'agent_session_operation_invalid' && reason === 'messageIdReused') ||
    (refusal.code === 'agent_session_ownership_unknown' && reason === 'sessionNotAttached')
  ) {
    // The id holds another payload, or the chat is closed on the host, which answers that before
    // looking the id up: no resend can settle it, and what an earlier attempt left is in the chat.
    return settledByJournal(context)
  }
  // An older host may refuse a resent id before looking it up, so only the next resend can tell.
  return context.answersProve ? returnedFor(refusal) : stillSendingFor(refusal)
}

/** A request that threw is not an answer: no code tells "never written" from "written, then the
 *  answer was lost", and a thrown refusal may come after the host wrote the row. Only a host that
 *  turned the call away before running it (a method it lacks, params it rejects) proves no row,
 *  and only on a first attempt: an earlier one may have landed before the host turned this away. */
function thrownSettlement(
  answer: Extract<StructuredAgentSessionSendAnswer, { kind: 'thrown' }>,
  context: StructuredAgentSessionOutboxSettlementContext
): StructuredAgentSessionOutboxSettlement {
  if (answer.refusal) {
    return stillSendingFor(answer.refusal)
  }
  const failure = agentSessionRpcErrorFailure(answer.rpcCode)
  if (failure.kind !== 'refused') {
    return { kind: 'unanswered' }
  }
  return context.firstAttempt ? returnedFor(failure) : stillSendingFor(failure)
}

/** Whether the host itself answered: a refusal it returned or threw, or a code it turned the call
 *  away with. Anything else is the transport, which says nothing about the host. */
function answeredByHost(answer: StructuredAgentSessionSendAnswer): boolean {
  return (
    answer.kind === 'result' ||
    answer.refusal !== undefined ||
    agentSessionRpcErrorFailure(answer.rpcCode).kind === 'refused'
  )
}

/** The host's answer to one attempt, as one of the three ends. Past the host's window for the id,
 *  an answer the host gave that settles nothing never will (a host that refuses before looking the
 *  id up refuses it every time), so the journal decides; lost contact still only goes again. */
export function settleStructuredAgentSessionSendAnswer(
  answer: StructuredAgentSessionSendAnswer,
  clientMessageId: string,
  context: StructuredAgentSessionOutboxSettlementContext
): StructuredAgentSessionOutboxSettlement {
  const settlement = settleAnswer(answer, clientMessageId, context)
  return settlement.kind === 'unanswered' && context.outlivedHostWindow && answeredByHost(answer)
    ? settledByJournal(context)
    : settlement
}

function settleAnswer(
  answer: StructuredAgentSessionSendAnswer,
  clientMessageId: string,
  context: StructuredAgentSessionOutboxSettlementContext
): StructuredAgentSessionOutboxSettlement {
  if (answer.kind === 'thrown') {
    return thrownSettlement(answer, context)
  }
  const { result } = answer
  if (!result.ok) {
    return refusalSettlement(agentSessionRefusalFailure(result.refusal), context)
  }
  if ('queued' in result.value) {
    return { kind: 'recorded' }
  }
  const { submission } = result.value
  // A replay answering with the hand-off of the draft this send queued: the host owns it.
  if (submission.queuedMessageId === clientMessageId) {
    return { kind: 'recorded' }
  }
  // The host makes this record up when it has a ledger answer but no journal row: an older host
  // whose journal lost the row, or this build's replay of an accepted send whose row a new journal
  // epoch dropped. Only a loaded row says the message is in the chat; otherwise the words say to
  // check it.
  if (
    submission.dispatchState === 'unknown' &&
    submission.reason === DISPATCH_DOUBT_SUBMISSION_MISSING
  ) {
    return settledByJournal(context)
  }
  return settleStructuredAgentSessionSendRow(submission, context.rowLoaded)
}

/** When the host's replay window for this id closes, measured as the host measures it from the
 *  id's own time, or null for an id with no time. Past it the host refuses the id for good. */
export function structuredAgentSessionEntryHostWindowEndsAt(
  entry: Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId'>
): number | null {
  const madeAt = parseAgentSessionOperationTimestamp(entry.clientMessageId)
  return madeAt === null ? null : madeAt + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS
}

/** Whether the host can no longer settle this id. Past it, a host answer that settles nothing
 *  hands the entry back for the journal to decide, and a live journal settles one only an owed
 *  answer would; lost contact alone keeps it, since it says nothing about the host. */
export function structuredAgentSessionEntryOutlivedHostWindow(
  entry: Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId'>,
  now: number
): boolean {
  const endsAt = structuredAgentSessionEntryHostWindowEndsAt(entry)
  return endsAt !== null && now > endsAt
}

/** A row the host holds for the send. */
function settleStructuredAgentSessionSendRow(
  submission: AgentJournalSubmission,
  rowLoaded: boolean
): StructuredAgentSessionOutboxSettlement {
  if (submission.dispatchState === 'pending') {
    return { kind: 'pending' }
  }
  if (structuredAgentSessionRejectionAwaitsItsRow(submission, rowLoaded)) {
    const { reason, rejection } = structuredAgentSessionRejectedFailure(submission)
    return { kind: 'rejectedUnseen', recorded: { reason, ...(rejection ? { rejection } : {}) } }
  }
  // A withdrawn hand-off of a queued draft is never given back: the Stop put the card back.
  if (
    submission.dispatchState === 'rejected' &&
    dispatchWasWithdrawn(submission) &&
    submission.queuedMessageId === undefined
  ) {
    return { kind: 'withdrawn' }
  }
  // Accepted, rejected, or in doubt (a restart lost its outcome): the row says which, for everyone.
  return { kind: 'recorded' }
}

export type StructuredAgentSessionJournalReading = {
  submissions: readonly AgentJournalSubmission[]
  /** How far this client has read the journal; null until a page has loaded. */
  cursor: AgentJournalCursor | null
  /** The entry's own request is still out, so its answer will settle it. */
  inFlightClientMessageId: string | null
  /** Ids of the drafts the host publishes as queued; null until it has published a list. */
  queuedMessageIds: readonly string[] | null
  /** The item ids of the loaded journal rows. */
  loadedItemIds: ReadonlySet<string>
  /** This client's clock, for the host window. */
  now: number
}

function readThrough(
  reading: StructuredAgentSessionJournalReading,
  at: AgentJournalCursor
): boolean {
  return (
    reading.cursor !== null &&
    reading.cursor.epoch === at.epoch &&
    reading.cursor.sequence >= at.sequence
  )
}

/**
 * What the journal alone settles about an entry, or null while it settles nothing. A row settles
 * it as the send's answer would. Without a row:
 * - an entry an older build left waiting for a Retry that no longer exists is handed back once the
 *   journal has loaded, with words that say to check the chat (never sent again on its own: the
 *   person was told it did not go);
 * - an entry a Stop outran is handed back once the journal is read through the Stop's own answer:
 *   the host runs a chat's sends and Stops one at a time, so a send it took before the Stop has its
 *   row by then. A journal that moved to another epoch can't say, nor can a Stop that will never
 *   be answered, so those say to check the chat;
 * - either one past the host's window for its id is handed back to check the chat: nothing can
 *   settle it any more.
 */
export function settleStructuredAgentSessionEntryFromJournal(
  entry: StructuredAgentSessionOutboxEntry,
  reading: StructuredAgentSessionJournalReading
): StructuredAgentSessionOutboxSettlement | null {
  // Already settled: its text is on its way back to the draft.
  if (entry.returning) {
    return null
  }
  // The host's row owns it: the copy goes once that row draws it, or once nothing could anymore.
  if (entry.recordedRejection) {
    return reading.loadedItemIds.has(agentJournalSubmissionKey(entry.clientMessageId)) ||
      structuredAgentSessionEntryOutlivedHostWindow(entry, reading.now)
      ? { kind: 'recorded' }
      : null
  }
  // The host handed it off as a queued draft, in whatever state: the card carries it.
  if (
    reading.submissions.some((candidate) => candidate.queuedMessageId === entry.clientMessageId)
  ) {
    return { kind: 'recorded' }
  }
  const submission = reading.submissions.find(
    (candidate) => candidate.clientMessageId === entry.clientMessageId
  )
  if (submission) {
    // Only a drawn entry waits for its row: an older build's is never drawn, and past the host's
    // window the copy is not kept, so it can't wait forever for a page nobody loads.
    const settlement = settleStructuredAgentSessionSendRow(
      submission,
      entry.legacyUnsettled === true ||
        structuredAgentSessionEntryOutlivedHostWindow(entry, reading.now) ||
        reading.loadedItemIds.has(agentJournalSubmissionKey(entry.clientMessageId))
    )
    // A pending row changes nothing a dispatching entry doesn't already show, so an unchanged batch
    // writes nothing.
    return settlement.kind === 'pending' && entry.state === 'dispatching' ? null : settlement
  }
  // The host holds it as a queued draft: its card carries the text.
  if (reading.queuedMessageIds?.includes(entry.clientMessageId)) {
    return { kind: 'recorded' }
  }
  if (reading.cursor === null || reading.inFlightClientMessageId === entry.clientMessageId) {
    return null
  }
  if (
    entry.legacyUnsettled === true ||
    (structuredAgentSessionEntryAwaitsSettlement(entry) &&
      structuredAgentSessionEntryOutlivedHostWindow(entry, reading.now))
  ) {
    return { kind: 'returned', words: [...STRUCTURED_AGENT_SESSION_SEND_UNCONFIRMED_WORDS] }
  }
  const stopCursor = entry.stoppedBy?.cursor
  if (stopCursor) {
    if (reading.cursor.epoch !== stopCursor.epoch) {
      return { kind: 'returned', words: [...STRUCTURED_AGENT_SESSION_SEND_UNCONFIRMED_WORDS] }
    }
    // A queued draft is no journal row, so only the published list can say the host lacks it.
    const queueSendUnknown =
      entry.sentDelivery === 'queue-if-active' && reading.queuedMessageIds === null
    return readThrough(reading, stopCursor) && !queueSendUnknown ? { kind: 'withdrawn' } : null
  }
  if (entry.stoppedBy?.unanswerable === true) {
    return { kind: 'returned', words: [...STRUCTURED_AGENT_SESSION_SEND_UNCONFIRMED_WORDS] }
  }
  return null
}

/** The outbox after a settlement, and the entry whose text goes back to the draft, if any: that one
 *  stays, marked returning, until the draft is saved. */
export type StructuredAgentSessionSettledOutbox = {
  entries: StructuredAgentSessionOutboxEntry[]
  returned: {
    entry: StructuredAgentSessionOutboxEntry
    /** Null for a Stop's withdrawal, which says nothing. */
    words: AgentSessionWriteNoticePart[] | null
  } | null
}

export function applyStructuredAgentSessionOutboxSettlement(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  clientMessageId: string,
  settlement: StructuredAgentSessionOutboxSettlement
): StructuredAgentSessionSettledOutbox {
  const entry = entries.find((candidate) => candidate.clientMessageId === clientMessageId)
  if (!entry) {
    return { entries: [...entries], returned: null }
  }
  const others = entries.filter((candidate) => candidate !== entry)
  switch (settlement.kind) {
    case 'recorded':
      return { entries: others, returned: null }
    case 'withdrawn':
    case 'returned': {
      // Kept, marked, until storage confirms the draft holds its text (R2: never lost).
      const returning = { ...entry, returning: { ending: 'returned' as const } }
      return {
        entries: entries.map((candidate) => (candidate === entry ? returning : candidate)),
        returned: {
          entry: returning,
          words: settlement.kind === 'returned' ? settlement.words : null
        }
      }
    }
    case 'rejectedUnseen':
      return {
        entries: entries.map((candidate) =>
          candidate === entry ? { ...candidate, recordedRejection: settlement.recorded } : candidate
        ),
        returned: null
      }
    case 'pending':
    case 'unanswered': {
      const state = settlement.kind === 'pending' ? 'dispatching' : 'unconfirmed'
      return {
        entries: entries.map((candidate) =>
          candidate === entry ? { ...candidate, state } : candidate
        ),
        returned: null
      }
    }
  }
}
