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

type TurnEndState = Pick<
  JournalReducerState,
  'items' | 'queuePauseMarks' | 'latestPersonTurnSequence'
>

/** Whether the latest Stop is a person's that names turn `turnId` or names none: an end that gives
 *  no verdict of its own is then theirs to decide, here, where its row is built. */
export function personStopMayNameTurn(stop: JournalLatestStop | null, turnId: string): boolean {
  return (
    stop !== null &&
    stopIsAPersons(stop.event.reason) &&
    (stop.event.turnId === undefined || stop.event.turnId === turnId)
  )
}

/** Whether `stop` makes the end of turn `turnId` a person's cancellation: a person's Stop or close
 *  that named that turn, or named none and stopped the turn item `itemId` opened. */
function stopIsTurnCancellation(
  stop: JournalLatestStop,
  turnId: string,
  state: TurnEndState,
  itemId: string | null
): boolean {
  return (
    personStopMayNameTurn(stop, turnId) &&
    (stop.event.turnId !== undefined || turnlessStopStopped(state, stop, itemId))
  )
}

/** Pressed before any turn showed, a Stop stopped the first turn opened after it, and no later
 *  one: unless a send a person made since was accepted, whose turn that is. `itemId` null: a turn
 *  not yet opened. */
function turnlessStopStopped(
  state: TurnEndState,
  stop: JournalLatestStop,
  itemId: string | null
): boolean {
  const createdAt = itemId === null ? null : (state.items.get(itemId)?.sequence ?? null)
  if (
    (createdAt !== null && createdAt <= stop.sequence) ||
    state.latestPersonTurnSequence >= stop.sequence
  ) {
    return false
  }
  for (const [otherId, item] of state.items) {
    if (
      otherId !== itemId &&
      item.body.kind === 'turn' &&
      item.sequence > stop.sequence &&
      (createdAt === null || item.sequence < createdAt)
    ) {
      return false
    }
  }
  return true
}

/** Whether a person's Stop already decides the end of what runs now: the live turn `turnId`, or
 *  with none, the turn a send opens next. A host stop of that work must not supersede it. */
export function personStopInForce(state: TurnEndState, turnId: string | null): boolean {
  const stop = state.queuePauseMarks.latestStop
  if (!stop || !stopIsAPersons(stop.event.reason)) {
    return false
  }
  if (turnId === null) {
    return stop.event.turnId === undefined && turnlessStopStopped(state, stop, null)
  }
  const itemId = [...state.items].find(
    ([, item]) => readAgentJournalTurn(item.body)?.turnId === turnId
  )?.[0]
  return stopIsTurnCancellation(stop, turnId, state, itemId ?? null)
}

/**
 * The body to write for item `itemId`: unchanged unless it ends, with no verdict of its own and no
 * earlier than the latest Stop event, a person's, which named it, or stopped it before it showed,
 * while it was still open (running, or unproven). A provider's own verdict always stands.
 */
export function turnEndAfterStop(
  state: TurnEndState,
  itemId: string,
  body: AgentJournalItemBody
): AgentJournalItemBody {
  if (body.kind !== 'turn' || body.state !== 'interrupted' || body.outcome !== undefined) {
    return body
  }
  const previous = readAgentJournalTurn(state.items.get(itemId)?.body)
  // An end already written stands: the Stop came after it.
  if (previous && previous.state !== 'running' && previous.state !== 'unverifiable') {
    return body
  }
  const stop = state.queuePauseMarks.latestStop
  if (!stop || !stopIsTurnCancellation(stop, body.turnId, state, itemId)) {
    return body
  }
  // An exit the provider saw before the Stop was news, whenever its end is written.
  const endedAfterStop = body.completedAt === undefined || body.completedAt >= stop.event.at
  return endedAfterStop ? { ...body, outcome: 'cancellation' } : body
}
