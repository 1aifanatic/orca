// Stop's pause on the queue. A Stop never withdraws a draft and no text ever
// travels back over the wire: it appends ONE journal row where it took effect, and
// the queue's pause is derived from that row (`queued-message-pause.ts`) until a
// turn a person asked for is sent after it, or they Resume. The cards stay
// published, and Send-now sends one card without lifting the pause for the rest
// until that card's turn starts. The row is bookkeeping: a failure is reported
// and never gates the interrupt.

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** The one unsettled-card predicate /clear's carry and the budget share:
 *  waiting or returned. Pending/unknown/accepted deliveries stay outside it. */
export function unsettledQueuedMessages(journal: AgentSessionJournal): QueuedMessageRow[] {
  return journal.queuedMessages.list().filter(isUnsettledQueuedMessage)
}

/**
 * Runs a Stop, which calls `tookEffect` where it takes effect — after it withdrew the
 * queued sends, before it reaches the agent, or, reaching no agent, once it withdrew
 * something. That writes the Stop's row, whatever the queue holds, so a card its
 * interrupt later withdraws comes back to waiting under the pause. A Stop that throws
 * before then changed nothing and wrote nothing. The drain cannot slip a card in
 * between: the Stop runs on the drain's serialized lane, and the consume re-judges the
 * pause in its own transaction.
 */
export async function runStopWithQueuePause<TValue>(
  ctx: AgentSessionTurnContext,
  stop: (tookEffect: () => Promise<void>) => Promise<TurnOutcome<TValue>>
): Promise<TurnOutcome<TValue>> {
  return stop(() =>
    ctx.journal.appendQueuePauseMark('stopped', ctx.fence).then(
      () => undefined,
      (error: unknown) => {
        console.warn("[agent-session] Stop's queue row skipped:", {
          sessionId: ctx.sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    )
  )
}
