// Whether a chat reads "Stopping…": a person's Stop is still settling, or the turn it stopped, or
// failed to stop, still runs. The host reads it on each journal commit and each settle edge from
// the Stop's event and what its settle bound (`journal-stop-turn-end.ts`), so nothing is stored
// and it clears when that turn ends. A Stop that settled having stopped nothing binds no turn, so
// a later one never reads Stopping. Clients only present it.

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { stopIsAPersons } from '../agent-session-journal/journal-stop-turn-end'

/** Whether the latest person's Stop is still settling, or is bound to the turn running now: the
 *  one it named, or the one its settle bound. */
export function structuredAgentSessionStopping(
  journal: Pick<AgentSessionJournal, 'stopMarks'>,
  items: readonly AgentJournalRenderItem[]
): boolean {
  const stop = journal.stopMarks.latest()
  if (stop === null || !stopIsAPersons(stop.event.reason)) {
    return false
  }
  if (stop.settle?.settling === true) {
    return true
  }
  const bound = stop.event.turnId ?? stop.settle?.turnId
  return bound !== undefined && bound === activeStructuredAgentSessionTurnId(items)
}
