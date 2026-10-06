// What a chat shows a message's sender as: names from Orca's own records, most specific first, and
// never a title the agent paints on its own terminal.

import type { AgentMessageSender } from '../../../shared/agent-session-message-source'
import { defaultAgentChatLabel } from '../../../shared/agent-session-chat-label'
import type { AgentType } from '../../../shared/agent-status-types'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import type { Tab } from '../../../shared/tab-types'
import type { OrchestrationDb } from './db'
import { lineageLiveSession, type AgentSessionRecordReader } from './structured-session-lineage'

export type TerminalSenderNaming = {
  /** The tab's stored title: a rename, by the person or through the CLI. Never its live title. */
  customTitle: string | null
  agent: AgentType | null
  /** Its pane, which an active dispatch still names after the handle was reissued. */
  paneKey: string | null
}

export type SenderNamingSources = {
  db: OrchestrationDb | null
  records: AgentSessionRecordReader | null
  /** The chat's tab as this host mirrors the workspace session. */
  chatTab: (worktreeId: string, sessionId: string) => Pick<Tab, 'customLabel' | 'label'> | null
  terminal: (handle: string) => TerminalSenderNaming | null
}

type Party = AgentMessageSender['party']

export function orchestrationSenderName(party: Party, sources: SenderNamingSources): string | null {
  const federated = party.address.startsWith('dispatch:')
  const terminal =
    !federated && party.terminalHandle ? sources.terminal(party.terminalHandle) : null
  const task = dispatchTaskName(party, federated, terminal, sources.db)
  if (task) {
    return task
  }
  if (party.orcaSessionId) {
    const record = sources.records ? lineageLiveSession(sources.records, party.orcaSessionId) : null
    if (record) {
      const tab = sources.chatTab(record.location.workspaceId, record.sessionId)
      return tab?.customLabel?.trim() || tab?.label.trim() || defaultAgentChatLabel(record.provider)
    }
  }
  if (terminal) {
    const agentLabel = terminal.agent ? formatAgentTypeLabel(terminal.agent) : null
    return terminal.customTitle?.trim() || agentLabel
  }
  return null
}

/** The task its dispatch was given: the federated `dispatch:<id>` address, or the dispatch a local
 *  worker holds, else the one it last held, since its own `worker_done` settles that dispatch
 *  before the report is delivered. A handle is issued per run, so its latest is this run's. */
function dispatchTaskName(
  party: Party,
  federated: boolean,
  terminal: TerminalSenderNaming | null,
  db: OrchestrationDb | null
): string | null {
  if (!db) {
    return null
  }
  const handle = party.terminalHandle
  const dispatch = federated
    ? db.getDispatchContextById(party.address.slice('dispatch:'.length))
    : handle
      ? (db.getActiveDispatchForTerminal(handle, terminal?.paneKey ?? undefined) ??
        db.getLatestDispatchForTerminal(handle))
      : undefined
  const task = dispatch ? db.getTask(dispatch.task_id) : undefined
  return task?.display_name || task?.task_title || null
}
