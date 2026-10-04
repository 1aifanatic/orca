// What a journal row does to the drafts, and the re-derivation behind it. The
// live hook runs inside each append's transaction; it is bookkeeping and may be
// skipped, so a dispatched draft whose current submission the journal already
// rejected is owed the settlement it would have applied, which the open-time
// repair and the drain both apply.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import {
  consumedSubmissionWasRejected,
  journalDispatchRowNewlyRejects
} from './journal-dispatch-settlement'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { queueShowsCard } from './queued-message-pause'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import { draftDeliveredByEcho, draftsDeliveredByAppliedEcho } from './queued-message-delivered-echo'
import {
  getQueuedMessage,
  listQueuedMessages,
  settleRejectedQueuedMessage,
  withdrawQueuedMessages,
  type QueuedMessageRow
} from './queued-message-table'

type Submissions = ReadonlyMap<string, AgentJournalSubmission>

/** `settleRejectedQueuedMessage`, except for a card the person cannot see. Refused, it is not
 *  returned to them; pulled back by a Stop, it does not go back to waiting, where nothing would
 *  hold it and the queue would send it again at once. Either way the host withdraws it, and
 *  whoever queued it re-derives it. A restart's interruption still puts it back to waiting. */
function settleRefusedQueuedMessage(
  db: Database.Database,
  input: Parameters<typeof settleRejectedQueuedMessage>[1]
): boolean {
  const consumed = listQueuedMessages(db, input.sessionId).find(
    (row) => row.consumedAs === input.consumedRef && row.state === 'dispatched'
  )
  if (!settleRejectedQueuedMessage(db, input)) {
    return false
  }
  const settled = consumed && getQueuedMessage(db, input.sessionId, consumed.messageId)
  const stopped =
    classifyDispatchRejection({ reason: input.reason, rejection: input.rejection }).category ===
    'withdrawn'
  if (
    settled &&
    !queueShowsCard(settled.source) &&
    (settled.state === 'returned' || (settled.state === 'waiting' && stopped))
  ) {
    withdrawQueuedMessages(db, {
      sessionId: input.sessionId,
      messageIds: [settled.messageId],
      settledByOp: null,
      now: input.now
    })
  }
  return true
}

/** Some dispatched draft still waits on a settlement the journal already decided. */
export function queuedMessageSettlementOwed(
  rows: readonly QueuedMessageRow[],
  submissions: Submissions
): boolean {
  return rows.some(
    (row) =>
      row.state === 'dispatched' &&
      row.consumedAs !== null &&
      consumedSubmissionWasRejected(submissions.get(row.consumedAs))
  )
}

/** Applies each owed settlement, and withdraws each waiting draft an applied echo proves
 *  delivered (`draftsDeliveredByAppliedEcho`); returns how many drafts changed. */
export function settleOwedQueuedMessages(
  db: Database.Database,
  input: { sessionId: string; state: JournalReducerState; now: number }
): number {
  const { submissions } = input.state
  let settled = 0
  for (const row of listQueuedMessages(db, input.sessionId)) {
    const consumedRef = row.consumedAs
    const submission = consumedRef === null ? undefined : submissions.get(consumedRef)
    if (
      row.state !== 'dispatched' ||
      consumedRef === null ||
      !consumedSubmissionWasRejected(submission)
    ) {
      continue
    }
    const changed = settleRefusedQueuedMessage(db, {
      sessionId: input.sessionId,
      consumedRef,
      reason: submission?.reason ?? null,
      rejection: submission?.rejection,
      now: input.now
    })
    settled += changed ? 1 : 0
  }
  const delivered = draftsDeliveredByAppliedEcho(
    input.state,
    listQueuedMessages(db, input.sessionId)
  )
  if (delivered.length > 0) {
    settled += withdrawQueuedMessages(db, {
      sessionId: input.sessionId,
      messageIds: delivered,
      settledByOp: null,
      now: input.now
    }).length
  }
  return settled
}

/**
 * The live hook, before `row` applies: an echo proving a waiting draft's first
 * send was delivered withdraws it; a row that NEWLY settles a dispatched
 * draft's current submission to `rejected` settles the draft — a refusal
 * returns it, a withdrawal (a Stop, a restart) sends it back to waiting.
 * Decided by the same function the reducer folds rows through, so a row the
 * journal's settlement rules ignore never alters a draft. Returns how many
 * drafts changed.
 */
export function settleQueuedMessagesForRow(
  db: Database.Database,
  input: {
    sessionId: string
    state: JournalReducerState
    /** Read only once the row holds an unclaimed echo: a list read inside the append's
     *  transaction must not be cached under state a rollback could undo. */
    drafts: () => readonly QueuedMessageRow[]
    row: JournalRow
    now: number
  }
): number {
  const { row } = input
  let changed = 0
  const delivered = draftDeliveredByEcho(input.state, input.drafts, row)
  if (delivered !== null) {
    // Its first send reached the agent after all; sending it again would repeat it.
    changed += withdrawQueuedMessages(db, {
      sessionId: input.sessionId,
      messageIds: [delivered],
      settledByOp: null,
      now: input.now
    }).length
  }
  if (row.kind !== 'dispatch' || row.state !== 'rejected') {
    return changed
  }
  if (!journalDispatchRowNewlyRejects(input.state.submissions.get(row.clientMessageId), row)) {
    return changed
  }
  const settled = settleRefusedQueuedMessage(db, {
    sessionId: input.sessionId,
    consumedRef: row.clientMessageId,
    reason: row.reason,
    rejection: row.rejection,
    now: input.now
  })
  return changed + (settled ? 1 : 0)
}
