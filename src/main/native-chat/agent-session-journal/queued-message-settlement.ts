// Re-derivation behind the live settlement hook: a dispatched draft whose
// current submission the journal already rejected is owed the settlement the
// hook would have applied. The hook is bookkeeping and may be skipped, so the
// open-time repair and the drain both run this.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { consumedSubmissionWasRejected } from './journal-dispatch-settlement'
import {
  listQueuedMessages,
  settleRejectedQueuedMessage,
  type QueuedMessageRow
} from './queued-message-table'

type Submissions = ReadonlyMap<string, AgentJournalSubmission>

/** Some dispatched draft still waits on a settlement the journal already decided. */
export function queuedMessageSettlementOwed(
  rows: readonly QueuedMessageRow[],
  submissions: Submissions
): boolean {
  return rows.some(
    (row) =>
      row.state === 'dispatched' &&
      consumedSubmissionWasRejected(submissions.get(row.consumedAs ?? row.messageId))
  )
}

/** Applies each owed settlement; returns how many drafts it settled. */
export function settleOwedQueuedMessages(
  db: Database.Database,
  input: { sessionId: string; submissions: Submissions; now: number }
): number {
  let settled = 0
  for (const row of listQueuedMessages(db, input.sessionId)) {
    const consumedRef = row.consumedAs ?? row.messageId
    const submission = input.submissions.get(consumedRef)
    if (row.state !== 'dispatched' || !consumedSubmissionWasRejected(submission)) {
      continue
    }
    const changed = settleRejectedQueuedMessage(db, {
      sessionId: input.sessionId,
      consumedRef,
      reason: submission?.reason ?? null,
      rejection: submission?.rejection,
      now: input.now
    })
    settled += changed ? 1 : 0
  }
  return settled
}
