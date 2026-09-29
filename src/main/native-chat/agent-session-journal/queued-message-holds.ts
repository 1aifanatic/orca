// Holds on waiting drafts: what keeps one from auto-sending, stored on its row.

import type Database from '../../sqlite/sync-database'
import { getQueuedMessage, type QueuedMessageHoldReason } from './queued-message-table'

/** One row a hold newly reached, with the hold it replaced, so the holder can undo exactly it. */
export type QueuedMessageHoldChange = { messageId: string; previousHold: string | null }

/** Hold waiting drafts from auto-sending (a Stop, a failed conversion). The
 *  hold retires with the row: consume and withdraw clear it in their own
 *  UPDATE. Returns the rows the hold newly reached. */
export function holdQueuedMessages(
  db: Database.Database,
  input: {
    sessionId: string
    messageIds: readonly string[]
    reason: QueuedMessageHoldReason
  }
): QueuedMessageHoldChange[] {
  const update = db.prepare(
    `UPDATE queued_messages SET hold_reason = ?
     WHERE session_id = ? AND message_id = ? AND state = 'waiting'`
  )
  const held: QueuedMessageHoldChange[] = []
  for (const messageId of input.messageIds) {
    const row = getQueuedMessage(db, input.sessionId, messageId)
    if (row?.state !== 'waiting' || row.holdReason === input.reason) {
      continue
    }
    update.run(input.reason, input.sessionId, messageId)
    held.push({ messageId, previousHold: row.holdReason })
  }
  return held
}

/** Undo a hold: each row still under it gets back the hold it replaced. A row
 *  consumed, withdrawn or re-held since is left alone. */
export function restoreQueuedMessageHolds(
  db: Database.Database,
  input: {
    sessionId: string
    from: QueuedMessageHoldReason
    changes: readonly QueuedMessageHoldChange[]
  }
): number {
  const update = db.prepare(
    `UPDATE queued_messages SET hold_reason = ?
     WHERE session_id = ? AND message_id = ? AND state = 'waiting' AND hold_reason = ?`
  )
  let restored = 0
  for (const change of input.changes) {
    restored += Number(
      update.run(change.previousHold, input.sessionId, change.messageId, input.from).changes ?? 0
    )
  }
  return restored
}

/** Lift the stop-shaped holds once a user send starts its turn: a stored
 *  'stopped' (Stop, /clear carry) and the DERIVED restart hold — that row is
 *  adopted into the current host instance, the same fact the derivation reads,
 *  so no second copy exists. `send_failed` and unknown markers stay: they
 *  release only through an explicit Send. Returns how many rows it lifted. */
export function releaseQueuePauseHolds(
  db: Database.Database,
  input: { sessionId: string; hostInstance: string }
): number {
  return Number(
    db
      .prepare(
        `UPDATE queued_messages SET hold_reason = NULL, host_instance = ?
         WHERE session_id = ? AND state = 'waiting'
           AND (hold_reason = 'stopped' OR (hold_reason IS NULL AND host_instance <> ?))`
      )
      .run(input.hostInstance, input.sessionId, input.hostInstance).changes ?? 0
  )
}
