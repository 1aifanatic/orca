// What a proven end says about a Stop's note: the work the Stop meant to end did end.

import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'
import { STOP_NOTE_CANCELLATION_REQUESTED } from './structured-agent-session-turn-stop-notes'

/**
 * A settlement that ends turns `interrupted` on a proven exit also revises any Stop note on those
 * turns that an unproven attempt left unconfirmed: it says the Stop took. Found by the note's turn
 * scope, whatever its key, and re-derived by every settlement, so nothing is stored for it.
 */
export function stopNoteRevisionsForEndedTurns(
  items: readonly AgentJournalRenderItem[],
  turnEnds: readonly JournalLifecycleMutationInput[]
): JournalLifecycleMutationInput[] {
  const interrupted = new Set(
    turnEnds.flatMap((mutation) =>
      mutation.kind === 'item' && readAgentJournalTurn(mutation.body)?.state === 'interrupted'
        ? [agentJournalItemKey(mutation.identity)]
        : []
    )
  )
  if (interrupted.size === 0) {
    return []
  }
  return items.flatMap((item) => {
    const identity = parseAgentJournalItemKey(item.itemId)
    return identity &&
      isStructuredAgentSessionStopNote(item.itemId) &&
      item.body.kind === 'status' &&
      item.body.failure?.kind === 'cancelUnconfirmed' &&
      item.turnScope?.kind === 'turn' &&
      interrupted.has(item.turnScope.turnItemId)
      ? [
          {
            kind: 'item' as const,
            identity,
            body: { kind: 'status' as const, text: STOP_NOTE_CANCELLATION_REQUESTED },
            turnScope: item.turnScope
          }
        ]
      : []
  })
}
