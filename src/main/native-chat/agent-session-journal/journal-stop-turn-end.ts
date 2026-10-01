// What a Stop decides about the turn it named: the one rule every turn-end write passes through.
//
// A turn a person's Stop or close of this chat named, ending with no verdict of its own after that
// Stop's event, ends as their cancellation. A host stop, an eviction and no Stop at all leave the
// end as written. It runs where each row is built, inside the journal's serialized write, so it
// reads every Stop folded before the end: the adapter's settle, the host's fallback and a
// relaunch's settle all write through it, and every client folds the row it wrote.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalQueuePauseMarks } from './queued-message-pause'

export type JournalLatestStop = NonNullable<JournalQueuePauseMarks['latestStop']>

/** Only a person's own Stop, or their close of this chat, makes a cut turn their cancellation. */
function stopIsAPersons(reason: JournalStopEvent['reason']): boolean {
  switch (reason) {
    case 'user-stop':
    case 'user-close':
      return true
    case 'host-stop':
    case 'evict':
      return false
  }
}

/** Whether `stop` makes the end of turn `turnId` a person's cancellation: a person's Stop or close
 *  that named that turn (`opened`: or named none, and the turn opened under it). */
export function stopIsTurnCancellation(
  stop: JournalLatestStop | null,
  turnId: string,
  opened?: { createdAt: number | null; latestPersonTurnSequence: number }
): boolean {
  if (stop === null || !stopIsAPersons(stop.event.reason)) {
    return false
  }
  if (stop.event.turnId !== undefined || !opened) {
    return stop.event.turnId === turnId
  }
  // Pressed before the turn showed: the turn its row opened after the Stop, unless a send a
  // person made since was accepted, whose turn it would be.
  return (
    (opened.createdAt === null || opened.createdAt > stop.sequence) &&
    opened.latestPersonTurnSequence < stop.sequence
  )
}

/**
 * The body to write for item `itemId`: unchanged unless it ends, with no verdict of its own and no
 * earlier than the latest Stop event, a person's, which named it while it was still open (running,
 * or unproven). A provider's own verdict always stands.
 */
export function turnEndAfterStop(
  state: Pick<JournalReducerState, 'items' | 'queuePauseMarks' | 'latestPersonTurnSequence'>,
  itemId: string,
  body: AgentJournalItemBody
): AgentJournalItemBody {
  if (body.kind !== 'turn' || body.state !== 'interrupted' || body.outcome !== undefined) {
    return body
  }
  const existing = state.items.get(itemId)
  const previous = readAgentJournalTurn(existing?.body)
  // An end already written stands: the Stop came after it.
  if (previous && previous.state !== 'running' && previous.state !== 'unverifiable') {
    return body
  }
  const stop = state.queuePauseMarks.latestStop
  const opened = {
    createdAt: existing?.sequence ?? null,
    latestPersonTurnSequence: state.latestPersonTurnSequence
  }
  if (!stop || !stopIsTurnCancellation(stop, body.turnId, opened)) {
    return body
  }
  // An exit the provider saw before the Stop was news, whenever its end is written.
  const endedAfterStop = body.completedAt === undefined || body.completedAt >= stop.event.at
  return endedAfterStop ? { ...body, outcome: 'cancellation' } : body
}
