import {
  isSameAgentProcess,
  type AgentProcessPresence
} from '../../../shared/agent-process-presence'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerLifecycle } from './server-lifecycle'

export type AgentPresenceDiscoveryRequest = {
  paneKey: string
  ptyId: string
  tabId: string
  worktreeId: string
  terminalHandle: string
  isCurrent(): boolean
  discover(): Promise<AgentProcessPresence | undefined>
}

export abstract class AgentHookServerPresenceDiscovery extends AgentHookServerLifecycle {
  private discoveryGeneration = 0

  override stop(): void {
    this.discoveryGeneration += 1
    this.presenceDiscoveries.clear()
    super.stop()
  }

  private readonly presenceDiscoveries = new Map<string, Promise<void>>()

  discoverAgentPresence(request: AgentPresenceDiscoveryRequest): Promise<void> {
    const generation = this.discoveryGeneration
    const paneKey = this.resolvePaneKeyAlias(request.paneKey)
    const before = this.state.lastStatusByPaneKey.get(paneKey)
    if (before?.agentPresence?.process && !before.agentPresence.ended) {
      return Promise.resolve()
    }
    if (before && (before.connectionId !== null || before.worktreeId !== request.worktreeId)) {
      return Promise.resolve()
    }
    const pending = this.presenceDiscoveries.get(paneKey)
    if (pending) {
      return pending
    }
    const discovery = request
      .discover()
      .then((presence) => {
        if (
          generation !== this.discoveryGeneration ||
          !presence?.process ||
          presence.ended ||
          !request.isCurrent() ||
          this.resolvePaneKeyAlias(request.paneKey) !== paneKey ||
          this.state.lastStatusByPaneKey.get(paneKey) !== before ||
          this.getAgentStatusDisposition(paneKey) !== 'accept'
        ) {
          return
        }
        if (
          before?.agentPresence?.ended &&
          before.agentPresence.process &&
          isSameAgentProcess(before.agentPresence.process, presence.process)
        ) {
          return
        }
        if (
          before?.agentPresence &&
          !before.agentPresence.ended &&
          before.agentPresence.agent !== presence.agent
        ) {
          return
        }
        if (!before) {
          this.ingestTerminalStatus({
            ...request,
            connectionId: null,
            payload: { state: 'done', prompt: '', agentType: presence.agent }
          })
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main stores only timing-enriched rows through its validated ingress.
        const row = this.state.lastStatusByPaneKey.get(paneKey) as
          | EnrichedAgentHookEventPayload
          | undefined
        if (!row || row.connectionId !== null || row.worktreeId !== request.worktreeId) {
          return
        }
        if (before && row !== before) {
          return
        }
        const observedAt = Math.max(Date.now(), row.receivedAt + 1)
        const captured: EnrichedAgentHookEventPayload = before?.agentPresence?.ended
          ? {
              paneKey,
              tabId: request.tabId,
              worktreeId: request.worktreeId,
              terminalHandle: request.terminalHandle,
              connectionId: null,
              payload: { state: 'done', prompt: '', agentType: presence.agent },
              agentPresence: presence,
              receivedAt: observedAt,
              stateStartedAt: observedAt
            }
          : { ...row, agentPresence: presence }
        if (!this.writeLegacyStatusRow(captured)) {
          return
        }
        this.commitStatusRowMutation(row, captured)
        this.scheduleStatusPersist()
        this.notifyStatusChangeListeners()
        this.emitEnrichedStatus(captured)
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.presenceDiscoveries.get(paneKey) === discovery) {
          this.presenceDiscoveries.delete(paneKey)
        }
      })
    this.presenceDiscoveries.set(paneKey, discovery)
    return discovery
  }
}
