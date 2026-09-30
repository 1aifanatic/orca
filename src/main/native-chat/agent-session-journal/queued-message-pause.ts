// The queue's pause: a pure function of the journal fold and the cards, never a stored flag, so
// nothing has to retire it. Paused when:
//   - 'stopped': the latest Stop row has no later Resume row, and no turn a person asked for was
//     sent after it and accepted. A later Stop is simply the latest.
//   - 'cleared': a card /clear carried into this conversation waits, and no person's turn or
//     Resume has happened here since.
//   - 'restarted': a waiting card was written by another host process, and no person's turn has
//     started since this conversation opened.
// A person's turn is an accepted submission of origin `client`. Orchestration mail, a restart
// continuation, a launch prompt and the queue's own drain are `host` and never lift it.

import type { JournalQueuePauseMark, JournalTombstoneRow } from './journal-row-schema'

export type QueuePauseReason = 'stopped' | 'cleared' | 'restarted'

/** The latest Stop and Resume rows, folded by the reducer; 0 when none. */
export type JournalQueuePauseMarks = {
  stoppedSequence: number
  stoppedAt: number
  resumedSequence: number
}

export type DerivedQueuePause = {
  reason: QueuePauseReason
  /** Host clock the pause began at; a card created later is newer than it. */
  since: number
}

type QueueCard = {
  state: string
  holdReason: string | null
  createdAt: number
  hostInstance: string
  carriedFrom: string | null
}

export function createJournalQueuePauseMarks(): JournalQueuePauseMarks {
  return { stoppedSequence: 0, stoppedAt: 0, resumedSequence: 0 }
}

export function foldJournalQueuePauseMark(
  marks: JournalQueuePauseMarks,
  row: JournalTombstoneRow & { queuePause: JournalQueuePauseMark }
): void {
  if (row.queuePause === 'stopped') {
    marks.stoppedSequence = row.seq
    marks.stoppedAt = row.ts
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
  marks: JournalQueuePauseMarks
  latestPersonTurnSequence: number
  cards: readonly QueueCard[]
  hostInstance: string
  /** A person's turn started since this conversation opened. */
  restartEnded: boolean
}): DerivedQueuePause | null {
  const { marks, latestPersonTurnSequence } = input
  if (journalQueueStopHolds(marks, latestPersonTurnSequence)) {
    return { reason: 'stopped', since: marks.stoppedAt }
  }
  const waiting = input.cards.filter((card) => card.state === 'waiting')
  const carried = waiting.filter((card) => card.carriedFrom !== null)
  if (carried.length > 0 && latestPersonTurnSequence === 0 && marks.resumedSequence === 0) {
    return { reason: 'cleared', since: Math.max(...carried.map((card) => card.createdAt)) }
  }
  if (!input.restartEnded && waiting.some((card) => card.hostInstance !== input.hostInstance)) {
    // The process that wrote a card is gone: every card waits, whenever it was written.
    return { reason: 'restarted', since: Number.POSITIVE_INFINITY }
  }
  return null
}

// Open product decision: whether a pause also holds a card queued AFTER it began (for example
// typed while orchestration mail runs after a Stop). true: every waiting card waits for the person.
// false: only cards that existed when it began, or came back from it, wait; newer ones drain.
const PAUSE_HOLDS_CARDS_QUEUED_AFTER_IT = true

/** THE rule for which cards a pause holds: the drain, its consume, and publication all read it. */
export function queuePauseHolds(pause: DerivedQueuePause, card: QueueCard): boolean {
  return (
    card.state === 'waiting' &&
    card.holdReason === null &&
    (PAUSE_HOLDS_CARDS_QUEUED_AFTER_IT || card.createdAt <= pause.since)
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
