// A Stop's note sits on the turn it named. A later Stop of that turn reads the earlier note from the
// journal, so a repeated press adds no row, however late and from whichever client it arrives.

import type { AgentJournalTurnScope } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'

export const STOP_NOTE_CANCELLATION_REQUESTED = 'Cancellation requested.'
export const STOP_NOTE_ALREADY_FINISHED = 'The provider had already finished this turn.'

type TurnScope = Extract<AgentJournalTurnScope, { kind: 'turn' }>

/** The turn `turnId` names, running or ended, and whether an earlier Stop's note on it already
 *  said the Stop took effect or found the turn over: all a later Stop of it could say. */
export function structuredAgentSessionNamedTurnStop(
  journal: Pick<AgentSessionJournal, 'snapshot'>,
  turnId: string
): { turnScope: TurnScope; answered: boolean } | null {
  const items = journal.snapshot().items
  const turn = items.findLast((item) => readAgentJournalTurn(item.body)?.turnId === turnId)
  if (!turn) {
    return null
  }
  const answered = items.some(
    (item) =>
      item.turnScope?.kind === 'turn' &&
      item.turnScope.turnItemId === turn.itemId &&
      isStructuredAgentSessionStopNote(item.itemId) &&
      item.body.kind === 'status' &&
      (item.body.text === STOP_NOTE_CANCELLATION_REQUESTED ||
        item.body.text === STOP_NOTE_ALREADY_FINISHED)
  )
  return { turnScope: { kind: 'turn', turnItemId: turn.itemId }, answered }
}
