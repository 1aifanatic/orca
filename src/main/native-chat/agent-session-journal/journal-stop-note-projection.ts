import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isStructuredAgentSessionStopNote } from '../agent-session-wire/structured-agent-session-command-turn'
import { STOP_NOTE_CANCELLATION_REQUESTED } from '../agent-session-wire/structured-agent-session-turn-stop-notes'

/** The recorded turn end supersedes the earlier unconfirmed Stop for display only. */
export function projectJournalStopNote(
  item: AgentJournalRenderItem,
  items: ReadonlyMap<string, AgentJournalRenderItem>
): AgentJournalRenderItem {
  if (
    isStructuredAgentSessionStopNote(item.itemId) &&
    item.body.kind === 'status' &&
    item.body.failure?.kind === 'cancelUnconfirmed' &&
    item.turnScope?.kind === 'turn' &&
    readAgentJournalTurn(items.get(item.turnScope.turnItemId)?.body)?.state === 'interrupted'
  ) {
    return { ...item, body: { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED } }
  }
  return item
}
