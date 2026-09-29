// Stop's pause on the queue. A Stop never withdraws a draft and no text ever
// travels back over the wire: it records WHERE in the journal it took effect,
// and the queue is paused from there (`structured-agent-session-queued-pause.ts`
// derives it) until a turn a person asked for starts, or they Resume. The cards
// stay published, and Send-now sends one card without lifting the pause for the
// rest until that card's turn starts. The record is bookkeeping: a failure is
// reported and never gates the interrupt.

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import { isPausableQueuedMessage } from '../agent-session-journal/queued-message-pause-table'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** The one unsettled-card predicate /clear's carry and the budget share:
 *  waiting or returned. Pending/unknown/accepted deliveries stay outside it. */
export function unsettledQueuedMessages(journal: AgentSessionJournal): QueuedMessageRow[] {
  return journal.queuedMessages.list().filter(isUnsettledQueuedMessage)
}

/**
 * Runs a Stop and records its queue pause at the point it takes effect — after
 * it withdrew the queued sends, as it reaches the agent, or, reaching no agent,
 * once it withdrew something — and only over cards the queue then holds. The Stop calls `tookEffect` there. A Stop that
 * throws before then changed nothing and recorded nothing, so there is nothing
 * to undo; one that fails after it keeps the pause, since the interrupt may have
 * landed. A draft whose hand-off the Stop withdrew is back to waiting in its own
 * place, under this same pause. The drain cannot slip a draft in between: it
 * runs on the same serialized lane as the Stop.
 */
export async function runStopWithQueuePause<TValue>(
  ctx: AgentSessionTurnContext,
  stop: (tookEffect: () => Promise<void>) => Promise<TurnOutcome<TValue>>
): Promise<TurnOutcome<TValue>> {
  let recorded = false
  return stop(async () => {
    // A pause is over the cards it can hold back — the withdrawal's sent-back
    // hand-offs included. With none it would only catch a card typed long after.
    if (recorded || !ctx.journal.queuedMessages.list().some(isPausableQueuedMessage)) {
      return
    }
    recorded = true
    try {
      await ctx.journal.queuedMessages.recordPause('stopped')
    } catch (error) {
      console.warn("[agent-session] Stop's queue pause skipped:", {
        sessionId: ctx.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
