// The queue's pause: a pure function of the journal fold and the cards, never a stored flag, so
// nothing has to retire it. Which cards it holds is `queuePauseHolds`. Paused when:
//   - 'stopped': the latest Stop row has no later Resume row, and no turn a person asked for was
//     sent after it and accepted. A later Stop is simply the latest.
//   - 'cleared': a card /clear carried into this conversation waits, and no person's turn or
//     Resume has happened here since.
//   - 'restarted': a waiting card was written by another host process, and no person's turn has
//     started since this conversation opened.
// A person's turn is an accepted submission of origin `client`. Orchestration mail, a restart
// continuation, a launch prompt and the queue's own drain are `host` and never lift it.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalQueuePauseMark, JournalTombstoneRow } from './journal-row-schema'

export type QueuePauseReason = 'stopped' | 'cleared' | 'restarted'

/** The latest Stop and Resume rows, folded by the reducer; 0 when none. */
export type JournalQueuePauseMarks = {
  stoppedSequence: number
  resumedSequence: number
}

export type DerivedQueuePause = {
  reason: QueuePauseReason
  /** Where a Stop's pause began: a card queued at or after it is newer. Null for the others. */
  since: AgentJournalCursor | null
}

type QueueCard = {
  state: string
  holdReason: string | null
  hostInstance: string
  carriedFrom: string | null
  queuedAt: AgentJournalCursor | null
}

export function createJournalQueuePauseMarks(): JournalQueuePauseMarks {
  return { stoppedSequence: 0, resumedSequence: 0 }
}

export function foldJournalQueuePauseMark(
  marks: JournalQueuePauseMarks,
  row: JournalTombstoneRow & { queuePause: JournalQueuePauseMark }
): void {
  if (row.queuePause === 'stopped') {
    marks.stoppedSequence = row.seq
  } else if (row.queuePause === 'resumed') {
    marks.resumedSequence = row.seq
  }
}

/** The latest Stop still pauses: nothing a person did since, and no Resume, ended it. */
export function journalQueueStopHolds(
  marks: JournalQueuePauseMarks,
  latestPersonTurnSequence: number
): boolean {
  return marks.stoppedSequence > Math.max(latestPersonTurnSequence, marks.resumedSequence)
}

export function deriveQueuePause(input: {
  /** The journal's epoch: sequences compare only within one. */
  epoch: string
  marks: JournalQueuePauseMarks
  latestPersonTurnSequence: number
  cards: readonly QueueCard[]
  hostInstance: string
  /** A person's turn started since this conversation opened. */
  restartEnded: boolean
}): DerivedQueuePause | null {
  const { epoch, marks, latestPersonTurnSequence } = input
  if (journalQueueStopHolds(marks, latestPersonTurnSequence)) {
    return { reason: 'stopped', since: { epoch, sequence: marks.stoppedSequence } }
  }
  const waiting = input.cards.filter((card) => card.state === 'waiting')
  const carried = waiting.filter((card) => card.carriedFrom !== null)
  if (carried.length > 0 && latestPersonTurnSequence === 0 && marks.resumedSequence === 0) {
    return { reason: 'cleared', since: null }
  }
  if (!input.restartEnded && waiting.some((card) => card.hostInstance !== input.hostInstance)) {
    // The process that wrote a card is gone: every card waits, whenever it was written.
    return { reason: 'restarted', since: null }
  }
  return null
}

/** Queued before the pause began: for /clear, a card it carried; for a restart, every card. For a
 *  Stop, a card queued before its row; one from another epoch (before a rewind) or from a build
 *  that recorded no position counts as before. A withdrawn steer keeps its position, so is held. */
function queuedBeforePause(pause: DerivedQueuePause, card: QueueCard): boolean {
  if (pause.reason === 'cleared') {
    return card.carriedFrom !== null
  }
  const { since } = pause
  return (
    since === null ||
    card.queuedAt === null ||
    card.queuedAt.epoch !== since.epoch ||
    card.queuedAt.sequence < since.sequence
  )
}

// Product decision: a card queued AFTER a Stop is a new instruction and is not held; only cards
// queued before it, and a steer it withdrew, wait. It still never jumps ahead of a held card: the
// drain stops at the first one. true instead holds every waiting card, whenever it was queued.
const PAUSE_HOLDS_CARDS_QUEUED_AFTER_IT = false

/** THE rule for which cards a pause holds: the drain, its consume, and publication all read it. */
export function queuePauseHolds(pause: DerivedQueuePause, card: QueueCard): boolean {
  return (
    card.state === 'waiting' &&
    card.holdReason === null &&
    (PAUSE_HOLDS_CARDS_QUEUED_AFTER_IT || queuedBeforePause(pause, card))
  )
}

/** Whether Resume would send anything: a card the pause holds, not behind a returned card, which
 *  blocks everything after it until the user acts. Only then is the pause PUBLISHED, so its
 *  header never offers a Resume that sends nothing. */
export function queuePauseHoldsResumableCard(
  pause: DerivedQueuePause,
  cards: readonly QueueCard[]
): boolean {
  for (const card of cards) {
    if (card.state === 'returned') {
      return false
    }
    if (queuePauseHolds(pause, card)) {
      return true
    }
  }
  return false
}
