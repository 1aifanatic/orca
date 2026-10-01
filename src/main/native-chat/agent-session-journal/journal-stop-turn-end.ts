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

/** Whether `stop`, a person's, makes the end of turn `turnId` theirs: it named that turn, or named
 *  none and stopped the turn item `itemId` opened. */
function stopIsTurnCancellation(
  stop: JournalLatestStop,
  turnId: string,
  state: TurnEndState,
  itemId: string | null
): boolean {
  if (!stopIsAPersons(stop.event.reason)) {
    return false
  }
  return stop.event.turnId !== undefined
    ? stop.event.turnId === turnId
    : turnlessStopStopped(state, stop, itemId)
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

/** THE rule: whether the latest Stop makes turn `turnId` (item `itemId`, null if not yet opened),
 *  ending at `endedAt` with no verdict of its own, a person's cancellation. An exit the provider saw
 *  before the Stop was news, whenever its end is written. */
function stopEndsTurnAsCancellation(
  state: TurnEndState,
  turnId: string,
  itemId: string | null,
  endedAt: number | undefined
): boolean {
  const stop = state.queuePauseMarks.latestStop
  return (
    stop !== null &&
    stopIsTurnCancellation(stop, turnId, state, itemId) &&
    (endedAt === undefined || endedAt >= stop.event.at)
  )
}

/**
 * Whether a person's Stop decides the end of turn `turnId` (null: the turn a send opens next),
 * by `turnEndAfterStop`'s rule: ending at `endedAt` it is their cancellation, and still running it
 * is theirs to end. For a writer that must choose before the end is written: a host stop must not
 * supersede it, and a Claude error result naming no reason leaves its verdict to it.
 */
export function personStopDecidesTurn(
  state: TurnEndState,
  turnId: string | null,
  endedAt?: number
): boolean {
  if (turnId !== null) {
    const itemId = [...state.items].find(
      ([, item]) => readAgentJournalTurn(item.body)?.turnId === turnId
    )?.[0]
    return stopEndsTurnAsCancellation(state, turnId, itemId ?? null, endedAt)
  }
  const stop = state.queuePauseMarks.latestStop
  return (
    stop !== null &&
    stop.event.turnId === undefined &&
    stopIsAPersons(stop.event.reason) &&
    turnlessStopStopped(state, stop, null)
  )
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
  return stopEndsTurnAsCancellation(state, body.turnId, itemId, body.completedAt)
    ? { ...body, outcome: 'cancellation' }
    : body
}
