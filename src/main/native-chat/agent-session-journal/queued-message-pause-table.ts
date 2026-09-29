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

type QueueCardState = { state: string; holdReason: string | null }

/**
 * Whether a pause holds back anything Resume would send: a card waiting, with
 * no hold of its own, and not behind a returned card — which blocks everything
 * after it until the user acts, exactly as the drain reads it. A returned card
 * waits for the user anyway, and a held one for its own Send. The one rule the
 * publication, a Stop's record and the fact's retirement all read.
 */
export function hasResumableQueuedMessage(rows: readonly QueueCardState[]): boolean {
  for (const row of rows) {
    if (row.state === 'returned') {
      return false
    }
    if (row.state === 'waiting' && row.holdReason === null) {
      return true
    }
  }
  return false
}

/** A pause is over the cards it paused: once none is left Resume would send
 *  (`hasResumableQueuedMessage`), the fact goes too, in the same transaction as
 *  the write that took the last one, so it can never outlive them and catch a
 *  card typed long after. */
export function retireQueuePauseIfEmpty(db: Database.Database, sessionId: string): number {
  const rows = db
    .prepare(
      `SELECT state, hold_reason FROM queued_messages WHERE session_id = ? ORDER BY position ASC`
    )
    .all(sessionId)
    .flatMap((row) =>
      typeof row === 'object' &&
      row !== null &&
      'state' in row &&
      typeof row.state === 'string' &&
      'hold_reason' in row &&
      (row.hold_reason === null || typeof row.hold_reason === 'string')
        ? [{ state: row.state, holdReason: row.hold_reason }]
        : []
    )
  if (hasResumableQueuedMessage(rows)) {
    return 0
  }
  return Number(
    db.prepare('DELETE FROM queued_message_pauses WHERE session_id = ?').run(sessionId).changes ?? 0
  )
}
