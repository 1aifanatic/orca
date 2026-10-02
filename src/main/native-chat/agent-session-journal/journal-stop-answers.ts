// Whether a Stop still counts, from the answers its notes record: the one rule every reader of a
// Stop's effect applies (the turn-end write, the host stop's deference, and the "Stopping…" state).

import {
  agentJournalStopAnswerTook,
  readAgentJournalStopAnswer
} from '../../../shared/agent-session-stop-answer'
import type { JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'

/**
 * Whether the Stop that wrote `event` still counts as taking effect: it has no answer yet, or any
 * answer it has says it took. A later answer that it did not take never cancels one that says it
 * did. Answers attach by the event's `at`, so a rewind's restatement keeps them; an older host's
 * note, and an answer this build does not know, are no answer.
 */
export function journalStopStillCounts(
  state: Pick<JournalReducerState, 'items'>,
  event: Pick<JournalStopEvent, 'at'>
): boolean {
  let answered = false
  for (const item of state.items.values()) {
    const stop = readAgentJournalStopAnswer(item.body)
    if (stop?.eventAt !== event.at) {
      continue
    }
    if (agentJournalStopAnswerTook(stop.answer)) {
      return true
    }
    answered = true
  }
  return !answered
}
