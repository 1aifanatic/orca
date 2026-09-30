import type { AgentProcessPresence } from '../../../../shared/agent-process-presence'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type { AgentStatusSlice } from './agent-status-slice-contract'

export type AgentPresenceRecord = {
  presence: AgentProcessPresence
  receivedAt: number
  connectionId?: string | null
  worktreeId?: string
}

export type AgentPresenceByPaneKey = Readonly<Record<string, AgentPresenceRecord>>

export function createAgentPresenceActions(
  runtime: AgentStatusRuntime
): Pick<AgentStatusSlice, 'recordAgentPresence'> {
  return {
    recordAgentPresence: (paneKey, record) => {
      const previous = runtime.get().agentPresenceByPaneKey[paneKey]
      if (
        previous?.connectionId === record.connectionId &&
        previous &&
        previous.receivedAt > record.receivedAt
      ) {
        return
      }
      runtime.set((state) => {
        return {
          agentPresenceByPaneKey: { ...state.agentPresenceByPaneKey, [paneKey]: record },
          agentStatusEpoch: state.agentStatusEpoch + 1,
          sortEpoch: state.sortEpoch + 1
        }
      })
      if (record.presence.process && record.presence.ended) {
        runtime.get().removeAgentStatus(paneKey)
        runtime.runAfterCommit(() => {
          if (runtime.get().agentPresenceByPaneKey[paneKey] === record) {
            runtime.get().setCacheTimerStartedAt(paneKey, null)
          }
        })
      }
    }
  }
}
