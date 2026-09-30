import {
  AGENT_PROCESS_CAPTURE_EVENT,
  type AgentProcessPresence
} from '../shared/agent-process-presence'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { isAgentHookSource, type AgentHookSource } from '../shared/agent-hook-relay'

export type RelayPresenceDiscoveryRequest = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  terminalHandle?: string
  isCurrent(): boolean
  discover(): Promise<AgentProcessPresence | undefined>
}

export class RelayAgentPresenceDiscovery {
  private generation = 0

  clear(): void {
    this.generation += 1
    this.pending.clear()
  }

  private readonly pending = new Map<string, Promise<void>>()

  constructor(
    private readonly getRow: (paneKey: string) => AgentHookEventPayload | undefined,
    private readonly publish: (
      event: AgentHookEventPayload,
      source: AgentHookSource,
      captured: AgentProcessPresence
    ) => void
  ) {}

  discover(request: RelayPresenceDiscoveryRequest): Promise<void> {
    const generation = this.generation
    const current = () => this.getRow(request.paneKey)
    const before = current()
    if (before?.agentPresence?.process && !before.agentPresence.ended) {
      return Promise.resolve()
    }
    const pending = this.pending.get(request.paneKey)
    if (pending) {
      return pending
    }
    const discovery = request
      .discover()
      .then((presence) => {
        if (
          generation !== this.generation ||
          !presence?.process ||
          !isAgentHookSource(presence.agent) ||
          !request.isCurrent() ||
          current() !== before
        ) {
          return
        }
        const event =
          before && !before.agentPresence?.ended
            ? { ...before, agentPresence: presence }
            : {
                paneKey: request.paneKey,
                tabId: request.tabId,
                worktreeId: request.worktreeId,
                terminalHandle: request.terminalHandle,
                connectionId: null,
                payload: { state: 'done' as const, prompt: '', agentType: presence.agent },
                agentPresence: presence
              }
        this.publish(
          { ...event, hookEventName: AGENT_PROCESS_CAPTURE_EVENT },
          presence.agent,
          presence
        )
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.pending.get(request.paneKey) === discovery) {
          this.pending.delete(request.paneKey)
        }
      })
    this.pending.set(request.paneKey, discovery)
    return discovery
  }
}
