// What a Stop decides about the turn it named: the one rule every turn-end write passes through.
//
// A turn a person's Stop or close of this chat named, ending with no verdict of its own after that
// Stop's event and with no refusal answering it, ends as their cancellation. A host stop, an
// eviction, a refused Stop and no Stop at all leave the end as written. It runs where each row is
// built, inside the journal's serialized write, so it reads every Stop folded before the end: the
// adapter's settle, the host's fallback and a relaunch's settle all write through it, and every
// client folds the row it wrote.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import type {
  JournalStopEvent,
  JournalStopRefusal,
  JournalTombstoneRow
} from './journal-row-schema'

export type JournalStopRefusalMark = { sequence: number; refusal: JournalStopRefusal }

export type JournalLatestStop = {
  sequence: number
  event: JournalStopEvent
  /** A refusal written after it answers it: its turn ran on. */
  refused: boolean
}

/** The keys are read from disk unchecked: a value no build writes (a corrupt row) is ignored. */
export function foldJournalStopRefusal(
  state: Pick<JournalReducerState, 'latestStopRefusal'>,
  row: JournalTombstoneRow
): void {
  const refusal: unknown = row.stopRefusal
  if (
    typeof refusal === 'object' &&
    refusal !== null &&
    'stopAt' in refusal &&
    typeof refusal.stopAt === 'number' &&
    (!('turnId' in refusal) || typeof refusal.turnId === 'string')
  ) {
    state.latestStopRefusal = {
      sequence: row.seq,
      refusal: {
        stopAt: refusal.stopAt,
        ...('turnId' in refusal && typeof refusal.turnId === 'string'
          ? { turnId: refusal.turnId }
          : {})
      }
    }
  }
}

export function journalLatestStop(
  state: Pick<JournalReducerState, 'queuePauseMarks' | 'latestStopRefusal'>
): JournalLatestStop | null {
  const stop = state.queuePauseMarks.latestStop
  if (!stop) {
    return null
  }
  const answer = state.latestStopRefusal
  return {
    ...stop,
    refused:
      answer !== null &&
      answer.sequence > stop.sequence &&
      answer.refusal.stopAt === stop.event.at &&
      answer.refusal.turnId === stop.event.turnId
  }
}

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
 *  that named that turn (`opened`: or named none, and the turn opened under it), and that no
 *  refusal answered. */
export function stopIsTurnCancellation(
  stop: JournalLatestStop | null,
  turnId: string,
  opened?: { createdAt: number | null; latestPersonTurnSequence: number }
): boolean {
  if (stop === null || stop.refused || !stopIsAPersons(stop.event.reason)) {
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
 * or unproven) and which no refusal answered. A provider's own verdict always stands.
 */
export function turnEndAfterStop(
  state: Pick<
    JournalReducerState,
    'items' | 'queuePauseMarks' | 'latestStopRefusal' | 'latestPersonTurnSequence'
  >,
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
  const stop = journalLatestStop(state)
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
