import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'

/** Read provider ids back from the assembler's existing turn records. */
export function acpJournalTurnKey(row: AgentJournalRenderItem): string | undefined {
  const turn = readAgentJournalTurn(row.body)
  if (!turn) {
    return undefined
  }
  if (!turn.turnId.startsWith('p:')) {
    return turn.turnId
  }
  const value = turn.turnId.slice(turn.turnId.lastIndexOf(':') + 1)
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export function acpJournalToolTurn(
  rows: readonly AgentJournalRenderItem[],
  callId: string
): string | undefined {
  const tool = rows.find((row) => row.body.kind === 'tool-call' && row.body.callId === callId)
  const turnItemId = tool?.turnScope?.kind === 'turn' ? tool.turnScope.turnItemId : undefined
  const turn = rows.find((row) => row.itemId === turnItemId)
  return turn && acpJournalTurnKey(turn)
}
