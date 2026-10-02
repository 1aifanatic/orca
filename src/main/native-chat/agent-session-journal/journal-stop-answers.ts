// Whether a Stop still counts, from the answers its notes record: the one rule every reader of a
// Stop's effect on a turn's end applies (the turn-end write, and through it the readers that must
// choose before the end is written, and the "Stopping…" state).

import {
  agentJournalStopAnswerTook,
  isStructuredAgentSessionStopNote,
  readAgentJournalStopAnswer
} from '../../../shared/agent-session-stop-answer'
import type { JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'

/**
 * Whether the Stop that wrote `event` still counts as taking effect: it has no answer yet, or any
 * answer it has says it took. A later answer that it did not take never cancels one that says it
 * did. Answers name the event by its id; an event with none (an early dev build's), an older
 * host's note, and an answer this build does not know have no answer.
 */
export function journalStopStillCounts(
  state: Pick<JournalReducerState, 'items'>,
  event: Pick<JournalStopEvent, 'id'>
): boolean {
  if (event.id === undefined) {
    return true
  }
  let answered = false
  for (const [itemId, item] of state.items) {
    if (!isStructuredAgentSessionStopNote(itemId)) {
      continue
    }
    const stop = readAgentJournalStopAnswer(item.body)
    if (stop?.eventId !== event.id) {
      continue
    }
    if (agentJournalStopAnswerTook(stop.answer)) {
      return true
    }
    answered = true
  }
  return !answered
}
