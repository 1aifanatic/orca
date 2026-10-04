import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { providerTimelineKeyPart } from '../native-chat/agent-session-timeline/provider-timeline-identity'

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

export function acpJournalTurnIsSettled(
  rows: readonly AgentJournalRenderItem[],
  key: string
): boolean {
  return rows.some((row) => {
    const turn = readAgentJournalTurn(row.body)
    return (
      turn !== null &&
      turn.state !== 'running' &&
      (turn.turnId === key || turn.turnId.endsWith(`:${providerTimelineKeyPart(key)}`))
    )
  })
}

export function acpJournalTurnHasUser(
  rows: readonly AgentJournalRenderItem[],
  key: string
): boolean {
  const record = rows.find((row) => acpJournalTurnKey(row) === key)
  if (!record) {
    return false
  }
  const turn = readAgentJournalTurn(record.body)
  return rows.some(
    (row) =>
      row.body.kind === 'message' &&
      row.body.role === 'user' &&
      (row.itemId === turn?.userItemId ||
        (row.turnScope?.kind === 'turn' && row.turnScope.turnItemId === record.itemId))
  )
}
