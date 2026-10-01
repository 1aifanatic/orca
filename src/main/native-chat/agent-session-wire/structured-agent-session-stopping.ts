// Whether a chat reads "Stopping…": a person's Stop took effect and the work it stopped has not
// ended yet. The host derives it on each journal commit from facts the journal already holds — the
// Stop's event, the live turn and the Stop's own answer — so nothing is stored, and it clears when
// the turn ends or the Stop answers that it stopped nothing. Clients only present it.

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'

/** A Stop's note saying it did not take: the agent refused it, or it went unconfirmed. */
function noteSaysStopTookNoEffect(item: AgentJournalRenderItem): boolean {
  const { body } = item
  if (body.kind !== 'status' || !('failure' in body)) {
    return false
  }
  const kind = body.failure?.kind
  return kind === 'stopRefused' || kind === 'cancelUnconfirmed'
}

/**
 * Whether the latest person's Stop is still ending the work it stopped: the live turn it named, or
 * with none, the sends it stopped (`personStopDecidesTurn`), unless the newest Stop answer since
 * that Stop says it stopped nothing. A later press of the same Stop writes no event, only its
 * answer, so the newest answer is what counts.
 */
export function structuredAgentSessionStopping(
  journal: Pick<AgentSessionJournal, 'activeTurnId' | 'stopMarks'>,
  items: readonly AgentJournalRenderItem[]
): boolean {
  const stop = journal.stopMarks.latest()
  if (stop === null || !journal.stopMarks.personStopDecides(journal.activeTurnId())) {
    return false
  }
  let answer: AgentJournalRenderItem | undefined
  for (const item of items) {
    if (
      item.sequence > stop.sequence &&
      isStructuredAgentSessionStopNote(item.itemId) &&
      item.sequence >= (answer?.sequence ?? -1)
    ) {
      answer = item
    }
  }
  return answer === undefined || !noteSaysStopTookNoEffect(answer)
}
