// The queue-level pause fact: where in the journal the user's last Stop (or a
// /clear, which starts its replacement paused) took effect. The pause itself is never stored — it is derived from this fact and
// the journal rows after it (a user-requested turn that started ends it); the
// fact only records the one event the journal's closed row kinds cannot carry.
// An explicit Resume retires it.

import type Database from '../../sqlite/sync-database'

export type QueuePauseReason = 'stopped' | 'cleared'

export type QueuePauseFact = {
  reason: QueuePauseReason
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
    (row.reason !== 'stopped' && row.reason !== 'cleared') ||
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

/** A card a pause can hold back: waiting, with no hold of its own. A returned
 *  card waits for the user anyway, and a held one for its own Send, so a pause
 *  over only those has nothing for Resume to send. */
export function isPausableQueuedMessage(row: {
  state: string
  holdReason: string | null
}): boolean {
  return row.state === 'waiting' && row.holdReason === null
}

/** A pause is over the cards it paused: once none is left it can hold back
 *  (`isPausableQueuedMessage`), the fact goes too, in the same transaction as the
 *  write that removed the last one, so it can never outlive them and catch a
 *  card typed long after. */
export function retireQueuePauseIfEmpty(db: Database.Database, sessionId: string): number {
  return Number(
    db
      .prepare(
        `DELETE FROM queued_message_pauses WHERE session_id = ?
           AND NOT EXISTS (SELECT 1 FROM queued_messages
                           WHERE session_id = ? AND state = 'waiting' AND hold_reason IS NULL)`
      )
      .run(sessionId, sessionId).changes ?? 0
  )
}
