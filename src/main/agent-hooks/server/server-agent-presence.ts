import { admitAgentForeground } from '../../../shared/agent-foreground-admission'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessPresence,
  type AgentProcessVerdict
} from '../../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-process-presence-probe'
import { ownerDoubtFromHook } from '../../../shared/agent-hook-presence-transition'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { isUncheckableAgentOwner } from './server-status-identity'
import { AgentHookServerLifecycle } from './server-lifecycle'
import { AgentOwnerLivenessRecheck } from '../../../shared/agent-owner-liveness-recheck'

export abstract class AgentHookServerAgentPresence extends AgentHookServerLifecycle {
  private windowsOwnerProbe?: (
    paneKey: string,
    identity: AgentProcessIdentity
  ) => Promise<AgentProcessVerdict>

  setWindowsAgentOwnerProbe(
    probe: (paneKey: string, identity: AgentProcessIdentity) => Promise<AgentProcessVerdict>
  ): void {
    this.windowsOwnerProbe = probe
  }

  // Why keyed by pane and owner: every hook rewrites the row, and one owner needs only one probe.
  private readonly presenceChecks = new Map<
    string,
    {
      owner: AgentProcessIdentity
      check: Promise<AgentProcessVerdict | null>
    }
  >()
  private readonly ownerLivenessRecheck = new AgentOwnerLivenessRecheck({
    listLiveOwnerPaneKeys: () =>
      [...this.state.lastStatusByPaneKey.values()]
        .filter((row) => row.connectionId === null && this.hasVerifiableAgentProcess(row.paneKey))
        .map((row) => row.paneKey),
    checkOwner: (paneKey) => this.checkAgentPresence(paneKey)
  })

  protected noteLiveAgentOwner(): void {
    this.ownerLivenessRecheck.noteLiveOwner()
  }

  stop(): void {
    this.ownerLivenessRecheck.stop()
    super.stop()
  }

  ingestForegroundPresence(
    scope: Pick<
      AgentHookEventPayload,
      'paneKey' | 'connectionId' | 'worktreeId' | 'tabId' | 'terminalHandle'
    >,
    presence: AgentProcessPresence
  ): void {
    if (
      this.closedAgentStatusPaneKeys.has(scope.paneKey) ||
      this.isClosedAgentStatusTabForPaneKey(scope.paneKey)
    ) {
      return
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every server store write attaches receipt and turn clocks.
    const before = this.state.lastStatusByPaneKey.get(scope.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const admitted = admitAgentForeground(before, presence, scope)
    if (!admitted) {
      return
    }
    const now = Date.now()
    const enriched = {
      ...(before && !before.providerSessionOnly && !before.agentPresence?.ended
        ? { ...before, ...admitted, receivedAt: now }
        : this.attachStatusTiming(admitted, now)),
      observation: this.stampObservation({ ...admitted, providerSessionOnly: true }, 'process', now)
    }
    if (!this.writeLegacyStatusRow(enriched)) {
      return
    }
    this.commitStatusRowMutation(before, enriched)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus({ ...enriched, providerSessionOnly: true })
  }

  /** Idle and exit hooks trigger exact-owner checks. */
  checkAgentPresenceAfterHook(event: AgentHookEventPayload, row: AgentHookEventPayload): void {
    const doubt = ownerDoubtFromHook(event, row)
    if (doubt) {
      void this.checkAgentPresence(row.paneKey)
    }
  }

  /** Whether this pane's owner carries a process identity that its execution host can check. */
  hasVerifiableAgentProcess(paneKey: string): boolean {
    const row = this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))
    // A pane with no row has no owner to check.
    if (!row?.agentPresence?.process || row.agentPresence.ended) {
      return false
    }
    return !isUncheckableAgentOwner(row)
  }

  /** Checks the recorded process without granting ownership to the triggering event. */
  checkAgentPresence(
    paneKey: string,
    expectedProcess?: AgentProcessIdentity
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
    // Why: an ended owner already published its exit; an unidentified or uncheckable owner is
    // left to the legacy rules.
    if (!row || !presence || !owner || presence.ended || isUncheckableAgentOwner(row)) {
      return Promise.resolve(null)
    }
    if (row.connectionId !== null) {
      return Promise.resolve('unverifiable')
    }
    const pending = this.presenceChecks.get(resolved)
    if (pending && isSameAgentProcess(pending.owner, owner)) {
      return pending.check
    }
    const entry: {
      owner: AgentProcessIdentity
      check: Promise<AgentProcessVerdict | null>
    } = { owner, check: Promise.resolve(null) }
    const probe =
      owner.platform === 'win32'
        ? (this.windowsOwnerProbe?.(resolved, owner) ?? Promise.resolve('unverifiable' as const))
        : probeAgentProcessPresence(owner)
    entry.check = probe
      .catch(() => 'unverifiable' as const)
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
        this.reconcileEndedProcessForPaneKeys([resolved], {
          kind: 'owner-exited',
          presence: { ...presence, ended: true }
        })
        return verdict
      })
      .finally(() => {
        if (this.presenceChecks.get(resolved) === entry) {
          this.presenceChecks.delete(resolved)
        }
      })
    this.presenceChecks.set(resolved, entry)
    return entry.check
  }
}
