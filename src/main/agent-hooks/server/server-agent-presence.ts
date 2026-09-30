import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessPresence,
  type AgentProcessVerdict
} from '../../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-process-presence-probe'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerLifecycle } from './server-lifecycle'

export abstract class AgentHookServerAgentPresence extends AgentHookServerLifecycle {
  private readonly presenceChecks = new WeakMap<
    AgentHookEventPayload,
    Promise<AgentProcessVerdict | null>
  >()

  /** A live hook proves its own process alive; only another process's hook casts doubt on the owner. */
  checkAgentPresenceAfterHook(event: AgentHookEventPayload, row: AgentHookEventPayload): void {
    const sender = event.agentPresence?.process
    const owner = row.agentPresence
    if (sender && owner?.process && !owner.ended && !isSameAgentProcess(sender, owner.process)) {
      const agent = event.agentPresence?.agent ?? event.payload.agentType
      // Why: a sender with no agent type cannot own a pane, so it only rechecks the owner.
      void this.checkAgentPresence(
        row.paneKey,
        undefined,
        agent && agent !== 'unknown' ? { agent, process: sender } : undefined
      )
    }
  }

  /** Whether this pane's owner carries a process identity that its execution host can check. */
  hasVerifiableAgentProcess(paneKey: string): boolean {
    const presence = this.state.lastStatusByPaneKey.get(
      this.resolvePaneKeyAlias(paneKey)
    )?.agentPresence
    return presence?.process !== undefined && !presence.ended
  }

  /** `successor` is the live process whose hook raised the doubt; it inherits a proven-dead owner's pane. */
  checkAgentPresence(
    paneKey: string,
    expectedProcess?: AgentProcessIdentity,
    successor?: AgentProcessPresence
  ): Promise<AgentProcessVerdict | null> {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    const row = this.state.lastStatusByPaneKey.get(resolved)
    if (expectedProcess) {
      const recorded = row?.agentPresence
      if (!recorded?.process || !isSameAgentProcess(recorded.process, expectedProcess)) {
        return Promise.resolve('unverifiable')
      }
      if (recorded.ended) {
        return Promise.resolve('exited')
      }
    }
    const presence = row?.agentPresence
    const owner = presence?.process
    // Why: an ended owner already published its exit, and an owner no hook identified cannot be checked.
    if (!row || !presence || !owner || presence.ended) {
      return Promise.resolve(null)
    }
    if (row.connectionId !== null) {
      return Promise.resolve('unverifiable')
    }
    const pending = this.presenceChecks.get(row)
    if (pending && !successor) {
      return pending
    }
    const check = probeAgentProcessPresence(owner)
      .then((verdict) => {
        // Why: fence on the owner, not the row object — cleanup can rewrite the row mid-probe.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Server admission enriches every stored row with receipt and turn clocks.
        const current = this.state.lastStatusByPaneKey.get(resolved) as
          | EnrichedAgentHookEventPayload
          | undefined
        const currentOwner = current?.agentPresence
        if (
          !current ||
          !currentOwner?.process ||
          !isSameAgentProcess(currentOwner.process, owner)
        ) {
          return 'unverifiable' as const
        }
        if (verdict !== 'exited' || currentOwner.ended) {
          return verdict
        }
        if (successor) {
          this.adoptPaneOwner(current, successor)
        } else {
          this.reconcileEndedProcessForPaneKeys([resolved], {
            kind: 'owner-exited',
            presence: { ...presence, ended: true }
          })
        }
        return verdict
      })
      .finally(() => {
        if (this.presenceChecks.get(row) === check) {
          this.presenceChecks.delete(row)
        }
      })
    this.presenceChecks.set(row, check)
    return check
  }

  /** The row already carries the successor's own status; only the recorded owner was stale. */
  private adoptPaneOwner(
    current: EnrichedAgentHookEventPayload,
    successor: AgentProcessPresence
  ): void {
    const adopted: EnrichedAgentHookEventPayload = { ...current, agentPresence: successor }
    if (!this.writeLegacyStatusRow(adopted)) {
      return
    }
    this.commitStatusRowMutation(current, adopted)
    this.scheduleStatusPersist()
    this.emitEnrichedStatus(adopted)
  }
}
