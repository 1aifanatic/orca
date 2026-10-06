// What a chat shows a message's sender as: only names Orca controls, never a title the agent
// set on its own terminal (it could call itself "You").

import type { AgentMessageSender } from '../../../shared/agent-session-message-source'
import { defaultAgentChatLabel } from '../../../shared/agent-session-chat-label'
import type { AgentType } from '../../../shared/agent-status-types'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import type { OrchestrationDb } from './db'
import { lineageLiveSession, type AgentSessionRecordReader } from './structured-session-lineage'

export type TerminalSenderNaming = {
  /** The title the person gave the tab, if any. */
  customTitle: string | null
  agent: AgentType | null
}

export function orchestrationSenderName(
  party: AgentMessageSender['party'],
  deps: {
    db: OrchestrationDb | null
    records: AgentSessionRecordReader | null
    terminal: (handle: string) => TerminalSenderNaming | null
  }
): string | null {
  // A federated sender is its dispatch here: named by the task it was given.
  const dispatchId = party.address.startsWith('dispatch:')
    ? party.address.slice('dispatch:'.length)
    : null
  if (dispatchId) {
    const dispatch = deps.db?.getDispatchContextById(dispatchId)
    const task = dispatch ? deps.db?.getTask(dispatch.task_id) : undefined
    return task?.display_name || task?.task_title || null
  }
  if (party.orcaSessionId) {
    const record = deps.records ? lineageLiveSession(deps.records, party.orcaSessionId) : null
    if (record) {
      return record.conversationName ?? defaultAgentChatLabel(record.provider)
    }
  }
  if (party.terminalHandle) {
    const terminal = deps.terminal(party.terminalHandle)
    if (terminal) {
      const agentLabel = terminal.agent ? formatAgentTypeLabel(terminal.agent) : null
      return terminal.customTitle?.trim() || agentLabel
    }
  }
  return null
}
