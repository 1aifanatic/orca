// What a refusal of a consumed draft's current hand-off does to the draft.

import type Database from '../../sqlite/sync-database'
import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { rejectedDraftSettlement } from './journal-dispatch-settlement'

/**
 * dispatched → returned, or back to waiting (`rejectedDraftSettlement`); a command card refused
 * in its own turn is spent (withdrawn) instead of returned,
 * matched on the draft's CURRENT hand-off (`consumed_as`), so a re-send refused
 * again still settles while a late duplicate of an earlier refusal matches
 * nothing. A draft back to waiting keeps its position and carries no refusal;
 * its spent submissions stay findable by their `queuedMessageId` link.
 */
export function settleRejectedQueuedMessage(
  db: Database.Database,
  input: {
    sessionId: string
    consumedRef: string
    reason: string | null
    rejection: UnreadAgentSessionFailureFact | undefined
    /** The refused submission's command turn exists, so its own row says why. */
    commandTurnReported: boolean
    now: number
  }
): boolean {
  const settlement = rejectedDraftSettlement({ reason: input.reason, rejection: input.rejection })
  if (
    settlement.state === 'returned' &&
    input.commandTurnReported &&
    spendRefusedCommandCard(db, input)
  ) {
    return true
  }
  const changed =
    settlement.state === 'waiting'
      ? db
          .prepare(
            `UPDATE queued_messages
             SET state = 'waiting', hold_reason = NULL, consumed_as = NULL,
                 returned_reason = NULL, returned_rejection = NULL, settled_at = NULL, settled_by_op = NULL
             WHERE session_id = ? AND state = 'dispatched' AND consumed_as = ?`
          )
          .run(input.sessionId, input.consumedRef)
      : db
          .prepare(
            `UPDATE queued_messages
             SET state = 'returned', returned_reason = ?, returned_rejection = ?, settled_at = ?
             WHERE session_id = ? AND state = 'dispatched' AND consumed_as = ?`
          )
          .run(
            input.reason,
            input.rejection ? JSON.stringify(input.rejection) : null,
            input.now,
            input.sessionId,
            input.consumedRef
          )
  return Number(changed.changes ?? 0) > 0
}

/**
 * A command card refused in its own turn is spent, not returned: that turn's row says why, once,
 * and a returned card would hold every card behind it. Refused before any turn (a failed start),
 * it is returned like any card. False when the dispatched card is not a command.
 */
function spendRefusedCommandCard(
  db: Database.Database,
  input: { sessionId: string; consumedRef: string; now: number }
): boolean {
  const spent = db
    .prepare(
      `UPDATE queued_messages SET state = 'withdrawn', settled_at = ?
       WHERE session_id = ? AND state = 'dispatched' AND consumed_as = ?
         AND json_extract(body_json, '$.command') IS NOT NULL`
    )
    .run(input.now, input.sessionId, input.consumedRef)
  return Number(spent.changes ?? 0) > 0
}
