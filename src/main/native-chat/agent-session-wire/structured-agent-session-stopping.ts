// Whether a chat reads "Stopping…": a person's Stop took effect and the work it stopped has not
// ended yet. The host derives it on each journal commit from facts the journal already holds — the
// Stop's event, the live turn and the Stop's own answer — so nothing is stored, and it clears when
// the turn ends or the Stop answers that it stopped nothing. Clients only present it.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isStructuredAgentSessionStopNote,
  structuredAgentSessionStopNoteIdentity
} from './structured-agent-session-command-turn'
import { stopNoteTookNoEffect } from './structured-agent-session-turn-stop-notes'

/** The newest turn record and its item, read backward off a position-ordered snapshot. */
function newestTurnItem(
  items: readonly AgentJournalRenderItem[]
): { item: AgentJournalRenderItem; turn: AgentJournalTurnLifecycle } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const turn = item ? readAgentJournalTurn(item.body) : null
    if (item && turn) {
      return { item, turn }
    }
  }
  return null
}

/**
 * Whether the latest person's Stop is still ending the work it stopped: the live turn it named, or
 * with none, the sends it stopped (`personStopDecidesTurn`), unless every answer to it says it
 * stopped nothing. Its answer is the note keyed by the turn its event records, revised in place by
 * each press, plus the notes of Stops pressed before any turn showed (keyed by their operation).
 * A press that took is never overwritten by a later no-effect one, so one that took keeps it.
 */
export function structuredAgentSessionStopping(
  journal: Pick<AgentSessionJournal, 'stopMarks' | 'itemBody'>,
  items: readonly AgentJournalRenderItem[]
): boolean {
  const stop = journal.stopMarks.latest()
  if (stop === null) {
    return false
  }
  // Read off the snapshot's tail with its opener, so no commit walks the whole journal for it.
  const newest = newestTurnItem(items)
  const live = newest?.turn.state === 'running' ? newest : null
  if (stop.event.turnId !== undefined && stop.event.turnId !== live?.turn.turnId) {
    return false
  }
  const decides = live
    ? journal.stopMarks.personStopDecidesOpenedTurn(live.turn.turnId, live.turn.userItemId)
    : journal.stopMarks.personStopDecides(null)
  if (!decides) {
    return false
  }
  const answerTurnId = stop.event.turnId ?? live?.turn.turnId
  const turnAnswer =
    answerTurnId === undefined
      ? null
      : agentJournalItemKey(structuredAgentSessionStopNoteIdentity(answerTurnId))
  // The turn's note, whenever it was first written, by its key.
  const turnNote = turnAnswer === null ? null : journal.itemBody(turnAnswer)
  if (turnNote !== null && !stopNoteTookNoEffect(turnNote)) {
    return true
  }
  let answered = turnNote !== null
  // The snapshot is in journal order, so the notes written since the Stop are its tail.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item || item.sequence <= stop.sequence) {
      break
    }
    const answers =
      item.itemId !== turnAnswer &&
      isStructuredAgentSessionStopNote(item.itemId) &&
      (item.turnScope?.kind !== 'turn' || item.turnScope.turnItemId === live?.item.itemId)
    if (answers) {
      if (!stopNoteTookNoEffect(item.body)) {
        return true
      }
      answered = true
    }
  }
  return !answered
}
