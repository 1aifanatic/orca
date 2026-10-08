// Per-draft holds: what keeps one card from auto-sending, stored on its row. A
// Stop, a /clear or a reopen pauses the queue instead (`queued-message-pause.ts`,
// derived); a per-draft hold is a conversion that failed (`QueuedMessageHoldReason`),
// which an explicit Send releases.

import type Database from '../../sqlite/sync-database'
import type { QueuedMessageHoldReason } from './queued-message-table'
import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { JournalQueuedMessages } from './journal-queued-messages'

/** Hold waiting drafts from auto-sending. The hold retires with the row: consume
 *  and withdraw clear it in their own UPDATE. Returns how many rows it newly reached. */
export function holdQueuedMessages(
  db: Database.Database,
  input: {
    sessionId: string
    messageIds: readonly string[]
    reason: QueuedMessageHoldReason
  }
): number {
  const update = db.prepare(
    `UPDATE queued_messages SET hold_reason = ?
     WHERE session_id = ? AND message_id = ? AND state = 'waiting'
       AND (hold_reason IS NULL OR hold_reason <> ?)`
  )
  let held = 0
  for (const messageId of input.messageIds) {
    held += Number(update.run(input.reason, input.sessionId, messageId, input.reason).changes ?? 0)
  }
  return held
}
/** waiting → returned with no hand-off: a card the host runs itself (a queued /clear) that could
 *  not run. Like a refused hand-off's card it blocks the cards behind it until its own Send or
 *  Delete; a returned card asked again keeps its place with the newer reason. */
export function returnUnsentQueuedCard(
  queued: Pick<JournalQueuedMessages, 'transact' | 'sessionId'>,
  input: {
    messageId: string
    reason: string | null
    rejection: UnreadAgentSessionFailureFact
    now: number
  }
): Promise<boolean> {
  return queued.transact(
    (db) =>
      returnUnsentQueuedMessage(db, {
        ...input,
        sessionId: queued.sessionId,
        rejection: JSON.stringify(input.rejection)
      }),
    (changed) => changed
  )
}

function returnUnsentQueuedMessage(
  db: Database.Database,
  input: {
    sessionId: string
    messageId: string
    reason: string | null
    rejection: string
    now: number
  }
): boolean {
  const changed = db
    .prepare(
      `UPDATE queued_messages
       SET state = 'returned', hold_reason = NULL, returned_reason = ?, returned_rejection = ?, settled_at = ?
       WHERE session_id = ? AND message_id = ? AND state IN ('waiting', 'returned')`
    )
    .run(input.reason, input.rejection, input.now, input.sessionId, input.messageId)
  return Number(changed.changes ?? 0) > 0
}
