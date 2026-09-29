// Retention for the draft table: which settled rows may be deleted, and when. A row is kept for
// as long as anything could still read it — a replayed operation, or a late refusal returning it.

import type Database from '../../sqlite/sync-database'
import { listQueuedMessages } from './queued-message-table'

/** What the loaded journal says about a dispatched draft's consumed submission. */
export type QueuedMessageSubmissionVerdict =
  /** Still owed an answer — a crash leftover the delivery loop will reject; keep the row. */
  | 'pending'
  /** `accepted` or `unknown`: terminal and not refused. */
  | 'terminal-not-refused'
  /** Absent from the current epoch. */
  | 'absent'
  /** Effectively rejected; the open-time repair returns it rather than pruning. */
  | 'rejected'

/**
 * Retention: `withdrawn` tombstones live for the operation-replay window;
 * a `dispatched` row only once its consumed submission is terminal-and-not-
 * refused or absent AND the window has passed — never while pending, so a slow
 * refusal can still return it. `waiting` and `returned` rows are never pruned.
 */
export function pruneQueuedMessages(
  db: Database.Database,
  input: {
    sessionId: string
    now: number
    replayWindowMs: number
    submissionVerdict: (consumedRef: string) => QueuedMessageSubmissionVerdict
  }
): number {
  const cutoff = input.now - input.replayWindowMs
  const tombstones = db
    .prepare(
      `DELETE FROM queued_messages
     WHERE session_id = ? AND state = 'withdrawn' AND settled_at IS NOT NULL AND settled_at < ?`
    )
    .run(input.sessionId, cutoff)
  let pruned = Number(tombstones.changes ?? 0)
  for (const row of listQueuedMessages(db, input.sessionId)) {
    if (row.state !== 'dispatched' || row.settledAt === null || row.settledAt >= cutoff) {
      continue
    }
    const verdict = input.submissionVerdict(row.consumedAs ?? row.messageId)
    if (verdict === 'terminal-not-refused' || verdict === 'absent') {
      db.prepare('DELETE FROM queued_messages WHERE session_id = ? AND message_id = ?').run(
        input.sessionId,
        row.messageId
      )
      pruned += 1
    }
  }
  return pruned
}
