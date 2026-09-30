// A Stop's event and the queue. A Stop never withdraws a draft and no text ever
// travels back over the wire: where it takes effect it appends ONE Stop event
// (`JournalStopEvent`), and the queue's pause is derived from it
// (`queued-message-pause.ts`) until a turn a person asked for is sent after it, or
// they Resume. The cards stay published, and Send-now sends one card without lifting
// the pause for the rest until that card's turn starts. The event is bookkeeping: a
// failure is reported and never gates the interrupt.

import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
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
 * Runs a Stop, which calls `tookEffect` where it takes effect: after it withdrew the queued
 * sends, and BEFORE the interrupt or anything that ends the child (the at-start stop, a running
 * command's stop, a kill after the interrupt), or, reaching no agent, once it withdrew something.
 * That writes the Stop's event, whatever the queue holds, so a card its interrupt later withdraws
 * comes back to waiting under the pause, and whatever ends the child finds the event already
 * written. A Stop that throws before then, or stops nothing, changed nothing and writes nothing.
 * The drain cannot slip a card in between: the Stop runs on the drain's serialized lane.
 */
export async function runRecordedStop<TValue>(
  ctx: AgentSessionTurnContext,
  /** `turnId` absent: the turn running when the Stop takes effect, if any. */
  event: Omit<JournalStopEvent, 'at'>,
  stop: (tookEffect: () => Promise<void>) => Promise<TurnOutcome<TValue>>
): Promise<TurnOutcome<TValue>> {
  return stop(() => {
    const turnId = event.turnId ?? ctx.journal.activeTurnId() ?? undefined
    return ctx.journal.appendStopEvent({ ...event, ...(turnId ? { turnId } : {}) }, ctx.fence).then(
      () => undefined,
      (error: unknown) => {
        console.warn("[agent-session] Stop's event row skipped:", {
          sessionId: ctx.sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    )
  })
}
