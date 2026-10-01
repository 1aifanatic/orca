// Whether a chat reads "Stopping…": a person's Stop took effect and the work it stopped has not
// ended yet. The host derives it on each journal commit from facts the journal already holds — the
// Stop's event, the live turn and the Stop's own answer — so nothing is stored, and it clears when
// the turn ends or the Stop answers that it stopped nothing. Clients only present it.

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { newestStructuredAgentSessionTurn } from '../../../shared/structured-agent-session-live-turn'
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
 * with none, the sends it stopped (`personStopDecidesTurn`), unless every Stop answer since then
 * says it stopped nothing. A repeat press writes no event, only its answer, so one press that took
 * keeps it whichever order the answers came in.
 */
export function structuredAgentSessionStopping(
  journal: Pick<AgentSessionJournal, 'stopMarks'>,
  items: readonly AgentJournalRenderItem[]
): boolean {
  const stop = journal.stopMarks.latest()
  if (stop === null) {
    return false
  }
  // Read off the snapshot's tail with its opener, so no commit walks the whole journal for it.
  const newest = newestStructuredAgentSessionTurn(items)
  const live = newest?.state === 'running' ? newest : null
  if (stop.event.turnId !== undefined && stop.event.turnId !== live?.turnId) {
    return false
  }
  const decides = live
    ? journal.stopMarks.personStopDecidesOpenedTurn(live.turnId, live.userItemId)
    : journal.stopMarks.personStopDecides(null)
  if (!decides) {
    return false
  }
  let answered = false
  for (const item of items) {
    if (item.sequence > stop.sequence && isStructuredAgentSessionStopNote(item.itemId)) {
      if (!noteSaysStopTookNoEffect(item)) {
        return true
      }
      answered = true
    }
  }
  return !answered
}
