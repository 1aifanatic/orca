/**
 * The agent-session operation id one structured worker mailbox's pointer send runs under.
 *
 * Orchestration's own `msg_<hex>` ids do not match the host's `^\d{13}-[0-9a-f]{32}$` shape and are
 * refused before the first send, so the id is minted here instead. It is durable and reused across
 * retries, because the id IS the send's idempotency key: a fresh id for the same nudge would land
 * as a second turn, and the host replays a recorded id's verdict without reaching the provider, so
 * a retry after a failed send starts nothing. It is re-minted only when the send is genuinely a
 * different call: a different batch of mail or session, or one the journal shows is owed again
 * (see `decideStructuredPointerAttempt`). Age cannot resolve delivery ambiguity.
 *
 * Reuse is keyed on the MESSAGE IDS in the batch, never on the pointer body: the body names only
 * how many messages are waiting, so two unrelated same-size batches share a fingerprint. Reusing a
 * live id across them makes the host answer from its operation ledger — `accepted`, with no turn
 * sent — and this lane then marks the new mail delivered. That is silent mail loss.
 */

import { createHash, randomBytes } from 'node:crypto'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { OrchestrationDb } from './db'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'

/** What the pointer lane reads off a session's journal for its own sends. */
export type StructuredPointerSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'rejection'
>

/**
 * What to do with a mailbox's pointer, given its operation row and the session's recorded sends.
 *
 * - `mint`: a new send. The batch or session changed, or the row's send failed and the journal
 *   says a retry is owed: a later send ran (the agent works again), the row was left by an earlier
 *   process (its restart settled the send without a turn), or the agent refused it only while an
 *   account switch was settling.
 * - `reuse`: resend under the row's id. Unrecorded, it is a first delivery; recorded as failed, the
 *   host replays that verdict and starts nothing, so a provider that dies on every turn is not
 *   restarted by every status edge, and a user's Stop stays stopped.
 * - `stamp`: the row's send ran; the batch is pointed.
 * - `park`: the row's send is still in flight; its settlement is the next edge.
 */
export type StructuredPointerAttempt = 'mint' | 'reuse' | 'stamp' | 'park'

export function decideStructuredPointerAttempt(input: {
  row: StructuredPointerOperationRow | undefined
  sessionId: string
  batchFingerprint: string
  /** The session's recorded sends, oldest first. */
  submissions: readonly StructuredPointerSubmission[]
  /** When this process's lane started; a row minted before it outlived its attempt. */
  laneStartedAtMs: number
}): StructuredPointerAttempt {
  const { row, submissions } = input
  if (
    !row ||
    row.session_id !== input.sessionId ||
    row.batch_fingerprint !== input.batchFingerprint
  ) {
    return 'mint'
  }
  const index = submissions.findIndex((entry) => entry.clientMessageId === row.operation_id)
  const sent = submissions[index]
  if (!sent) {
    return 'reuse'
  }
  if (sent.dispatchState === 'accepted') {
    return 'stamp'
  }
  if (sent.dispatchState === 'pending') {
    return 'park'
  }
  const ranSince = submissions.slice(index + 1).some((entry) => entry.dispatchState === 'accepted')
  const leftByEarlierProcess = row.minted_at_ms < input.laneStartedAtMs
  const accountSwitchSettling =
    sent.dispatchState === 'rejected' && sent.rejection?.kind === 'accountSwitchInProgress'
  return ranSince || leftByEarlierProcess || accountSwitchSettling ? 'mint' : 'reuse'
}

export function mintAgentSessionOperationId(now: number): string {
  return `${String(now).padStart(13, '0')}-${randomBytes(16).toString('hex')}`
}

/** Batch identity, and the only thing reuse may be keyed on. */
export function structuredPointerBatchFingerprint(
  sessionId: string,
  messageIds: readonly string[]
): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, messageIds]))
    .digest('base64url')
}

export function structuredPointerPayloadFingerprint(
  sessionId: string,
  body: AgentJournalMessageItem
): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body }
  })
}

export type StructuredPointerOperation =
  | { kind: 'send'; operationId: string; payloadFingerprint: string }
  | { kind: 'stamp' }
  | { kind: 'park' }

export function resolveStructuredPointerOperation(args: {
  db: OrchestrationDb
  mailboxHandle: string
  sessionId: string
  body: AgentJournalMessageItem
  /** The rows this nudge stands for; batch identity, not the body, decides reuse. */
  messageIds: readonly string[]
  submissions: readonly StructuredPointerSubmission[]
  laneStartedAtMs: number
  now?: number
}): StructuredPointerOperation {
  const now = args.now ?? Date.now()
  const payloadFingerprint = structuredPointerPayloadFingerprint(args.sessionId, args.body)
  const batchFingerprint = structuredPointerBatchFingerprint(args.sessionId, args.messageIds)
  const stored = args.db.getStructuredPointerOperation(args.mailboxHandle)
  const attempt = decideStructuredPointerAttempt({
    row: stored,
    sessionId: args.sessionId,
    batchFingerprint,
    submissions: args.submissions,
    laneStartedAtMs: args.laneStartedAtMs
  })
  if (attempt === 'stamp' || attempt === 'park') {
    return { kind: attempt }
  }
  if (attempt === 'reuse' && stored) {
    return { kind: 'send', operationId: stored.operation_id, payloadFingerprint }
  }
  const operationId = mintAgentSessionOperationId(now)
  args.db.putStructuredPointerOperation({
    mailbox_handle: args.mailboxHandle,
    session_id: args.sessionId,
    operation_id: operationId,
    batch_fingerprint: batchFingerprint,
    minted_at_ms: now
  })
  return { kind: 'send', operationId, payloadFingerprint }
}
