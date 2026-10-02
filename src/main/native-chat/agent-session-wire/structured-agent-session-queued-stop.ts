// A Stop's event and the queue. A Stop never withdraws a draft and no text ever
// travels back over the wire: where it takes effect it appends ONE Stop event
// (`JournalStopEvent`), and the queue's pause is derived from it
// (`queued-message-pause.ts`) until a turn a person asked for is sent after it, or
// they Resume. The cards stay published, and Send-now sends one card without lifting
// the pause for the rest until that card's turn starts. The event is bookkeeping: a
// failure is reported and never gates the interrupt.

import { randomUUID } from 'node:crypto'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { isMainAgentWorkingOnceFlushed } from './structured-agent-session-turns-cancel'
import {
  structuredAgentSessionStopNamesTurnNotLive,
  structuredAgentSessionStoppedTurnId
} from './structured-agent-session-turn-stop-notes'

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
 * written. A Stop that throws before then, or stops nothing (`stopRecordedWork`), changed
 * nothing and writes nothing. `tookEffect` resolves to the id it gave the event, which the
 * Stop's answer names; undefined when the write failed.
 * The drain cannot slip a card in between: the Stop runs on the drain's serialized lane.
 */
export async function runRecordedStop<TValue>(
  ctx: AgentSessionTurnContext,
  /** `turnId` absent: the turn running when the Stop takes effect, if any. */
  event: Omit<JournalStopEvent, 'at' | 'id'>,
  stop: (tookEffect: () => Promise<string | undefined>) => Promise<TurnOutcome<TValue>>
): Promise<TurnOutcome<TValue>> {
  const skipped = (error: unknown): undefined => {
    report(ctx, 'event row', error)
    return undefined
  }
  return stop(() => {
    try {
      const turnId = structuredAgentSessionStoppedTurnId(ctx.journal, event.turnId) ?? undefined
      const id = randomUUID()
      return ctx.journal
        .appendStopEvent({ ...event, id, ...(turnId ? { turnId } : {}) }, ctx.fence)
        .then(() => id, skipped)
    } catch (error) {
      // A throw before the append is queued is reported too: the Stop still interrupts.
      return Promise.resolve(skipped(error))
    }
  })
}

/**
 * What a Stop reaching a running agent finds recorded: `unrecorded` when it stops work no Stop event
 * records yet, so it writes one; the event of the Stop still in force when it repeats that Stop with
 * nothing sent since, on the same turn or one that opened after a Stop pressed before any turn
 * showed (a card queued between the presses then sends normally, as after one Stop); null when it
 * names a turn already over (a late Stop from a phone).
 */
export async function stopRecordedWork(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'flushStreamedEvents'>,
  namedTurnId: string | undefined
): Promise<'unrecorded' | JournalStopEvent | null> {
  const live = ctx.journal.activeTurnId()
  // No turn published yet while the agent works: the named one may still be opening.
  if (
    structuredAgentSessionStopNamesTurnNotLive(namedTurnId, live) &&
    (live !== null || !(await isMainAgentWorkingOnceFlushed(ctx)))
  ) {
    return null
  }
  const inForce = ctx.journal.queuedMessages.userStopInForce()
  if (inForce === null) {
    return 'unrecorded'
  }
  // Sent after that Stop and not refused, even if its fate is unknown: this interrupt may send it
  // back to waiting, so this Stop must hold it. A send with no sequence is an older host's.
  const sentSince = ctx.journal
    .submissions()
    .some(
      (entry) =>
        entry.dispatchState !== 'rejected' &&
        entry.acceptedSequence !== undefined &&
        entry.acceptedSequence > inForce.sequence
    )
  return sentSince || structuredAgentSessionStopNamesTurnNotLive(inForce.event.turnId, live)
    ? 'unrecorded'
    : inForce.event
}

function report(ctx: AgentSessionTurnContext, step: string, error: unknown): void {
  ctx.logger.warn(`Stop's ${step} failed`, {
    scope: 'stop-queued-bookkeeping',
    sessionId: ctx.sessionId,
    step,
    error
  })
}
