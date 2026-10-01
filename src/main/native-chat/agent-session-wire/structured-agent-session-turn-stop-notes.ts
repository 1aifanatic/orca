// The turn a Stop is about, read once for its event and its note. The note sits on that turn, found
// by the turn's id whether it still runs or has ended, and keyed by it, so a repeated Stop rewrites
// the one row instead of adding one.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'

export const STOP_NOTE_CANCELLATION_REQUESTED = 'Cancellation requested.'

/** The turn a Stop is about: the one it named, else the one running when it is read. */
export function structuredAgentSessionStoppedTurnId(
  journal: Pick<AgentSessionJournal, 'activeTurnId'>,
  namedTurnId: string | undefined
): string | null {
  return namedTurnId ?? journal.activeTurnId()
}

/** A Stop names a turn the journal does not show running, as a phone does once that turn ended. */
export function structuredAgentSessionStopNamesTurnNotLive(
  namedTurnId: string | undefined,
  liveTurnId: string | null
): boolean {
  return namedTurnId !== undefined && namedTurnId !== liveTurnId
}

/** The scope of the turn `turnId` names, running or ended; null when the journal has no such turn. */
export function structuredAgentSessionNamedTurnScope(
  journal: Pick<AgentSessionJournal, 'snapshot'>,
  turnId: string
): Extract<AgentJournalTurnScope, { kind: 'turn' }> | null {
  const turn = journal
    .snapshot()
    .items.findLast((item) => readAgentJournalTurn(item.body)?.turnId === turnId)
  return turn ? { kind: 'turn', turnItemId: turn.itemId } : null
}

/** What a person's Stop is aimed at, read once per Stop for both its event and its note. */
export type StructuredAgentSessionStopTarget = { namedTurnId?: string; endsSession: boolean }

/**
 * The turn a person's Stop records on its event, and so keys its note by: the one it named, unless
 * the Stop ends the provider's session (then whatever runs), else the one running. Null: none ran.
 */
export function structuredAgentSessionStopEventTurnId(
  journal: Pick<AgentSessionJournal, 'activeTurnId'>,
  stop: StructuredAgentSessionStopTarget
): string | null {
  return structuredAgentSessionStoppedTurnId(
    journal,
    stop.endsSession ? undefined : stop.namedTurnId
  )
}

/** The one key of a Stop's note, for its writer and every reader: the turn its event records
 *  (`structuredAgentSessionStopEventTurnId`), else, with no turn, the Stop's own operation. */
export function structuredAgentSessionStopNoteKey(
  eventTurnId: string | null | undefined,
  clientOperationId: string
): AgentJournalItemIdentity {
  return structuredAgentSessionStopNoteIdentity(eventTurnId ?? clientOperationId)
}

/** A Stop's note saying it did not take: the agent refused it, or it went unconfirmed. */
export function stopNoteTookNoEffect(body: AgentJournalItemBody | null | undefined): boolean {
  if (body?.kind !== 'status' || !('failure' in body)) {
    return false
  }
  const kind = body.failure?.kind
  return kind === 'stopRefused' || kind === 'cancelUnconfirmed'
}
