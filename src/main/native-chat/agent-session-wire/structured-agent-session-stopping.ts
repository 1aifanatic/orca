// Whether a chat reads "Stopping…": a person's Stop took effect and the work it stopped has not
// ended yet. The host derives it on each journal commit from facts the journal already holds — the
// Stop's event and the live turn — so nothing is stored, and it clears when that work ends. Clients
// only present it.

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { newestStructuredAgentSessionTurn } from '../../../shared/structured-agent-session-live-turn'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/**
 * Whether the latest person's Stop is still ending the work it stopped: the live turn it named, or
 * with none, the sends it stopped (`personStopDecidesTurn`). It holds until that work ends, whatever
 * the Stop's answer: a Stop the agent declined is still the person's, and a repeat press is how it
 * escalates.
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
  return live
    ? journal.stopMarks.personStopDecidesOpenedTurn(live.turnId, live.userItemId)
    : journal.stopMarks.personStopDecides(null)
}
