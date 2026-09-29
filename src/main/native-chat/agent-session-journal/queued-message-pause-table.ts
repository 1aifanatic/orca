// The queue-level Stop fact: where in the journal the user's last Stop took
// effect. The pause itself is never stored — it is derived from this fact and
// the journal rows after it (a user-requested turn that started ends it); the
// fact only records the one event the journal's closed row kinds cannot carry.
// An explicit Resume retires it.

import type Database from '../../sqlite/sync-database'

export type QueuePauseFact = {
  reason: 'stopped'
  /** The journal position the Stop took effect at: rows after it are later. */
  epoch: string
  sequence: number
  recordedAt: number
}

export function readQueuePause(db: Database.Database, sessionId: string): QueuePauseFact | null {
  const row: unknown = db
    .prepare(
      'SELECT reason, epoch, sequence, recorded_at FROM queued_message_pauses WHERE session_id = ?'
    )
    .get(sessionId)
  if (
    typeof row !== 'object' ||
    row === null ||
    !('reason' in row) ||
    row.reason !== 'stopped' ||
    !('epoch' in row) ||
    typeof row.epoch !== 'string' ||
    !('sequence' in row) ||
    typeof row.sequence !== 'number' ||
    !('recorded_at' in row) ||
    typeof row.recorded_at !== 'number'
  ) {
    // A reason this build cannot place reads as no pause rather than a wrong one.
    return null
  }
  return {
    reason: row.reason,
    epoch: row.epoch,
    sequence: row.sequence,
    recordedAt: row.recorded_at
  }
}

/** The latest Stop replaces an earlier one: only the last interruption decides. */
export function recordQueuePause(
  db: Database.Database,
  input: { sessionId: string; fact: QueuePauseFact }
): void {
  db.prepare(
    `INSERT INTO queued_message_pauses (session_id, reason, epoch, sequence, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       reason = excluded.reason, epoch = excluded.epoch,
       sequence = excluded.sequence, recorded_at = excluded.recorded_at`
  ).run(
    input.sessionId,
    input.fact.reason,
    input.fact.epoch,
    input.fact.sequence,
    input.fact.recordedAt
  )
}

/** Compare-and-clear: only the fact the caller judged, so a Stop recorded since stands. */
export function clearQueuePause(
  db: Database.Database,
  input: { sessionId: string; fact: Pick<QueuePauseFact, 'epoch' | 'sequence'> }
): number {
  return Number(
    db
      .prepare(
        'DELETE FROM queued_message_pauses WHERE session_id = ? AND epoch = ? AND sequence = ?'
      )
      .run(input.sessionId, input.fact.epoch, input.fact.sequence).changes ?? 0
  )
}
