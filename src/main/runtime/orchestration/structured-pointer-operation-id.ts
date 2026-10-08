// A mailbox keeps its send identity until delivery is proven or its durable mail is consumed.

import { createHash, randomBytes } from 'node:crypto'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS
} from '../../../shared/agent-session-host-authority'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import type { OrchestrationDb } from './db'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'

/** What the pointer lane reads off a session's journal for its own sends. */
export type StructuredPointerSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'submittedAt'
>

export type StructuredPointerAttempt = 'mint' | 'reuse' | 'stamp' | 'park'

export function decideStructuredPointerAttempt(input: {
  row: StructuredPointerOperationRow | undefined
  sessionId: string
  batchFingerprint: string
  /** The session's recorded sends; a rewind may have dropped the row's. */
  submissions: readonly StructuredPointerSubmission[]
  operationOutcome?: AgentSessionOperationOutcome
  /** Whether this process minted the row's id. */
  mintedByThisProcess: boolean
  now: number
}): StructuredPointerAttempt {
  const { row, submissions } = input
  if (!row || row.session_id !== input.sessionId) {
    return 'mint'
  }
  const sent = submissions.find((entry) => entry.clientMessageId === row.operation_id)
  if (sent?.dispatchState === 'accepted') {
    return 'stamp'
  }
  if (sent?.dispatchState === 'pending') {
    return 'park'
  }
  // New mail and a process restart cannot turn an uncertain accepted send into a second send.
  if (
    sent?.dispatchState === 'unknown' ||
    (!sent && input.operationOutcome?.status === 'succeeded') ||
    input.operationOutcome?.status === 'unknown'
  ) {
    return row.batch_fingerprint === input.batchFingerprint ? 'reuse' : 'park'
  }
  if (
    !sent &&
    !input.operationOutcome &&
    input.now - row.minted_at_ms > AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS
  ) {
    return 'park'
  }
  if (row.batch_fingerprint !== input.batchFingerprint) {
    return 'mint'
  }
  const ranSince = submissions.some(
    (entry) => entry.dispatchState === 'accepted' && entry.submittedAt > row.minted_at_ms
  )
  const tooOldToAdmit =
    !sent && input.now - row.minted_at_ms > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
  return ranSince || !input.mintedByThisProcess || tooOldToAdmit ? 'mint' : 'reuse'
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

export type StructuredPointerOperation =
  | { kind: 'send'; operationId: string }
  | { kind: 'stamp'; messageIds: string[] }
  | { kind: 'park' }

export function resolveStructuredPointerOperation(args: {
  db: OrchestrationDb
  mailboxHandle: string
  sessionId: string
  /** The rows this nudge stands for; batch identity, not the body, decides reuse. */
  messageIds: readonly string[]
  submissions: readonly StructuredPointerSubmission[]
  operationOutcome?: AgentSessionOperationOutcome
  /** The operation id this process last sent for this mailbox, if any. */
  sentByThisProcess: string | undefined
  now?: number
}): StructuredPointerOperation {
  const now = args.now ?? Date.now()
  const batchFingerprint = structuredPointerBatchFingerprint(args.sessionId, args.messageIds)
  const stored = args.db.getStructuredPointerOperation(args.mailboxHandle)
  const attempt = decideStructuredPointerAttempt({
    row: stored,
    sessionId: args.sessionId,
    batchFingerprint,
    submissions: args.submissions,
    operationOutcome: args.operationOutcome,
    mintedByThisProcess: stored?.operation_id === args.sentByThisProcess,
    now
  })
  if (attempt === 'stamp') {
    const messageIds =
      stored?.message_ids ??
      (stored?.batch_fingerprint === batchFingerprint ? args.messageIds : null)
    return messageIds ? { kind: 'stamp', messageIds: [...messageIds] } : { kind: 'park' }
  }
  if (attempt === 'park') {
    return { kind: 'park' }
  }
  if (attempt === 'reuse' && stored) {
    return { kind: 'send', operationId: stored.operation_id }
  }
  const operationId = mintAgentSessionOperationId(now)
  args.db.putStructuredPointerOperation({
    mailbox_handle: args.mailboxHandle,
    session_id: args.sessionId,
    operation_id: operationId,
    batch_fingerprint: batchFingerprint,
    message_ids: [...args.messageIds],
    // On the journal's clock too, so a backward clock step cannot date an earlier turn after it.
    minted_at_ms: args.submissions.reduce(
      (latest, entry) => Math.max(latest, entry.submittedAt),
      now
    )
  })
  return { kind: 'send', operationId }
}
