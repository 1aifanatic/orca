import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { isSameAgentProcess, type AgentProcessIdentity } from '../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'

type PendingCheck = {
  owner: AgentProcessIdentity
  check: Promise<void>
}

export class RelayAgentPresence {
  // Why keyed by pane and owner: every hook rewrites the row, and one owner needs only one probe.
  private readonly pending = new Map<string, PendingCheck>()

  /** Publish only proven exit of the currently recorded owner. */
  check(
    row: AgentHookEventPayload | undefined,
    current: () => AgentHookEventPayload | undefined,
    publish: (event: AgentHookEventPayload) => void
  ): Promise<void> {
    const presence = row?.agentPresence
    const owner = presence?.process
    if (!row || !presence || !owner || presence.ended) {
      return Promise.resolve()
    }
    const existing = this.pending.get(row.paneKey)
    if (existing && isSameAgentProcess(existing.owner, owner)) {
      return existing.check
    }
    const entry: PendingCheck = { owner, check: Promise.resolve() }
    entry.check = probeAgentProcessPresence(owner)
      .then((verdict) => {
        // Why: fence on the owner, not the row object — the doubting process keeps rewriting it.
        const latest = current()
        const latestOwner = latest?.agentPresence
        if (
          verdict !== 'exited' ||
          !latest ||
          !latestOwner?.process ||
          latestOwner.ended ||
          !isSameAgentProcess(latestOwner.process, owner)
        ) {
          return
        }
        publish({
          ...latest,
          hookEventName: 'AgentProcessExit',
          agentPresence: { ...presence, ended: true }
        })
      })
      .finally(() => {
        if (this.pending.get(row.paneKey) === entry) {
          this.pending.delete(row.paneKey)
        }
      })
    this.pending.set(row.paneKey, entry)
    return entry.check
  }
}
