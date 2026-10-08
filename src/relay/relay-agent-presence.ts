import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentProcessVerdict } from '../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'
import { PaneOwnerProbes } from '../shared/agent-pane-owner-probes'

export class RelayAgentPresence {
  /** Owner checks started by guests and other producers, rate-limited per owner. */
  readonly owners: PaneOwnerProbes

  constructor(
    private readonly host: {
      current: (paneKey: string) => AgentHookEventPayload | undefined
      publish: (paneKey: string, event: AgentHookEventPayload) => void
    }
  ) {
    this.owners = new PaneOwnerProbes({ checkOwner: (paneKey) => this.check(paneKey) })
  }

  private readonly pending = new WeakMap<
    AgentHookEventPayload,
    Promise<AgentProcessVerdict | null>
  >()

  check(paneKey: string): Promise<AgentProcessVerdict | null> {
    const row = this.host.current(paneKey)
    if (!row?.agentPresence?.process || row.agentPresence.ended) {
      return Promise.resolve(null)
    }
    const existing = this.pending.get(row)
    if (existing) {
      return existing
    }
    const presence = row.agentPresence
    const check = probeAgentProcessPresence(presence.process)
      .then((verdict) => {
        // Why: `exited` means this check released the pane; a row that moved on was not released.
        if (this.host.current(paneKey) !== row) {
          return 'unverifiable' as const
        }
        if (verdict === 'exited') {
          this.host.publish(paneKey, {
            ...row,
            hookEventName: 'AgentProcessExit',
            agentPresence: { ...presence, ended: true }
          })
        }
        return verdict
      })
      .finally(() => this.pending.delete(row))
    this.pending.set(row, check)
    return check
  }
}
