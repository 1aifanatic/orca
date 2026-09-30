import {
  isSameAgentProcess,
  type AgentProcessPresence
} from '../../../../shared/agent-process-presence'
import { removePaneKeys } from './agent-status-pane-keyed-records'
import { publishAgentPresence } from '@/lib/agent-presence-transitions'
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
): Pick<AgentStatusSlice, 'recordAgentPresence' | 'releaseAgentPresence'> {
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
      const ended = Boolean(record.presence.process && record.presence.ended)
      if (ended) {
        runtime.get().removeAgentStatus(paneKey)
      }
      runtime.runAfterCommit(() => {
        if (runtime.get().agentPresenceByPaneKey[paneKey] !== record) {
          return
        }
        if (ended) {
          runtime.get().setCacheTimerStartedAt(paneKey, null)
        }
        publishAgentPresence(paneKey, record.presence)
      })
    },
    releaseAgentPresence: (paneKey, process) => {
      const current = runtime.get().agentPresenceByPaneKey[paneKey]?.presence.process
      // Why: a release names one process, so it can never drop a replacement's record.
      if (!current || !isSameAgentProcess(current, process)) {
        return
      }
      runtime.set((state) => ({
        agentPresenceByPaneKey: removePaneKeys(state.agentPresenceByPaneKey, new Set([paneKey])),
        agentStatusEpoch: state.agentStatusEpoch + 1,
        sortEpoch: state.sortEpoch + 1
      }))
      runtime.runAfterCommit(() => publishAgentPresence(paneKey, undefined))
    }
  }
}
