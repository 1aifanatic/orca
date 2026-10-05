import { OrcaRuntimeWithAgentIdentityDiscovery } from './orca-runtime-agent-identity-discovery'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessVerdict
} from '../../shared/agent-process-presence'
import type { AgentPresenceChange } from '../agent-hooks/server/server-row-ownership'
import {
  AGENT_PRESENCE_BACKOFF_MS,
  AGENT_PRESENCE_FALLBACK_INTERVAL_MS,
  isFencedShellForeground,
  readRecognizedForegroundAgent,
  type AgentExitRun
} from './agent-exit-run-registry'
import { probeAgentProcessPresenceBatch } from './agent-process-presence-batch'

/**
 * Proof that the agent run in a PTY exited, never that a shell is empty: the canonical hook owner
 * ended (its own process-ending hook, or the store's probe), or the exact agent PID/start this host
 * measured is gone. Ordinary live status starts no probe; a run without an identity costs at most
 * three fenced captures until something changes.
 */
export class OrcaRuntimeWithAgentExitProof extends OrcaRuntimeWithAgentIdentityDiscovery {
  private readonly agentPresenceNudged = new Set<string>()
  private agentPresenceTickTimer: ReturnType<typeof setTimeout> | null = null
  private agentPresenceTickRunning = false

  /** Targeted presence of known agents on this host (the execution host for local PTYs). */
  protected probeAgentProcessIdentities(
    identities: readonly AgentProcessIdentity[]
  ): Promise<AgentProcessVerdict[]> {
    return probeAgentProcessPresenceBatch(identities)
  }

  /** Overridden by the chat-view layer: a pane clients may show as chat is backed by `ptyId`. */
  protected isAgentExitChatCandidate(_ptyId: string): boolean {
    return false
  }

  /** Overridden by the chat-view layer: act on a proven, revalidated end of `run`. */
  protected onAgentRunExitProven(_run: AgentExitRun, _observedAtMs: number): void {}

  protected forgetAgentExitRun(ptyId: string): void {
    super.forgetAgentExitRun(ptyId)
    this.agentPresenceNudged.delete(ptyId)
  }

  /** A pane's canonical owner changed: a new owner begins a run; its own end proves this one. */
  noteAgentOwnerPresenceChange(change: AgentPresenceChange): void {
    const ptyId = this.getPtyRecordForPaneKey(change.paneKey)?.ptyId
    const record = ptyId ? this.readAgentExitPty(ptyId) : null
    if (!ptyId || !record) {
      return
    }
    const { presence } = change
    const run = this.agentExitRuns.current(ptyId)
    if (presence && !presence.ended) {
      const sameRun = presence.process
        ? run?.identity && isSameAgentProcess(run.identity, presence.process)
        : run && !run.endHandled && run.agent === presence.agent
      if (!sameRun) {
        // Why before any await: an older run's evidence must never act on this one.
        this.agentExitRuns.begin(ptyId, {
          incarnationId: record.incarnationId,
          agent: presence.agent,
          identity: presence.process ?? null,
          source: 'hook'
        })
        if (!presence.process) {
          this.startAgentIdentityDiscovery(ptyId)
        }
        this.scheduleAgentPresenceTick()
      }
      return
    }
    if (
      presence?.ended &&
      presence.process &&
      run?.identity &&
      run.incarnationId === record.incarnationId &&
      isSameAgentProcess(run.identity, presence.process)
    ) {
      run.ownerEndedAtMs ??= Date.now()
      this.handleAgentRunEnd(run, run.ownerEndedAtMs)
    } else if (!presence && run?.identity) {
      // Why only a look: a removed row (transport blip, cleanup) is not proof of anything.
      this.nudgeAgentPresenceCheck(ptyId)
    }
  }

  /** A title exit or a finished shell command: a reason to look at a known agent now. */
  protected nudgeAgentExitCheck(ptyId: string): void {
    const run = this.agentExitRuns.current(ptyId)
    if (!run?.identity || !this.isAgentExitChatCandidate(ptyId)) {
      return
    }
    if (run.ownerEndedAtMs !== undefined) {
      // Why: the owner already said it ended; the hook can precede the process leaving the pane.
      this.handleAgentRunEnd(run, run.ownerEndedAtMs)
    } else {
      this.nudgeAgentPresenceCheck(ptyId)
    }
  }

  /** Recognized agent activity: a chat pane's run without an identity may now be measurable. */
  protected noteNativeChatAgentEvidence(ptyId: string): void {
    if (!this.agentExitRuns.current(ptyId)?.identity && this.isAgentExitChatCandidate(ptyId)) {
      this.startAgentIdentityDiscovery(ptyId)
    }
  }

  private nudgeAgentPresenceCheck(ptyId: string): void {
    this.agentPresenceNudged.add(ptyId)
    this.scheduleAgentPresenceTick(0)
  }

  /** One timer for every identified run: the earliest due fallback, or now for a nudge. */
  protected scheduleAgentPresenceTick(delayMs?: number): void {
    const now = Date.now()
    const due =
      delayMs ??
      Math.min(
        ...this.agentExitRuns
          .all()
          .filter((run) => this.isProbeEligible(run))
          .map((run) => run.nextProbeAtMs - now)
      )
    if (!Number.isFinite(due) || this.agentPresenceTickRunning) {
      return
    }
    if (this.agentPresenceTickTimer) {
      clearTimeout(this.agentPresenceTickTimer)
    }
    this.agentPresenceTickTimer = setTimeout(
      () => void this.runAgentPresenceTick(),
      Math.max(0, due)
    )
    this.agentPresenceTickTimer.unref?.()
  }

  private isProbeEligible(run: AgentExitRun): boolean {
    const record = this.readAgentExitPty(run.ptyId)
    return Boolean(
      run.identity &&
      !run.endHandled &&
      record &&
      record.incarnationId === run.incarnationId &&
      this.canProbeAgentProcessLocally(record) &&
      this.isAgentExitChatCandidate(run.ptyId)
    )
  }

  protected async runAgentPresenceTick(): Promise<void> {
    this.agentPresenceTickTimer = null
    this.agentPresenceTickRunning = true
    const startedAtMs = Date.now()
    try {
      const due = this.agentExitRuns
        .all()
        .filter(
          (run) =>
            this.isProbeEligible(run) &&
            (this.agentPresenceNudged.has(run.ptyId) || run.nextProbeAtMs <= startedAtMs)
        )
      this.agentPresenceNudged.clear()
      const identities = due.flatMap((run) => (run.identity ? [run.identity] : []))
      const verdicts =
        identities.length > 0 ? await this.probeAgentProcessIdentities(identities) : []
      due.forEach((run, index) => {
        const verdict = verdicts[index]
        if (!this.agentExitRuns.isCurrent(run) || run.endHandled) {
          return
        }
        if (verdict === 'exited') {
          this.handleAgentRunEnd(run, startedAtMs)
          return
        }
        run.failedProbes = verdict === 'live' ? 0 : run.failedProbes + 1
        const backoff =
          verdict === 'live'
            ? AGENT_PRESENCE_FALLBACK_INTERVAL_MS
            : AGENT_PRESENCE_BACKOFF_MS[run.failedProbes - 1]
        run.nextProbeAtMs = backoff === undefined ? Number.POSITIVE_INFINITY : Date.now() + backoff
      })
    } finally {
      this.agentPresenceTickRunning = false
      this.scheduleAgentPresenceTick(this.agentPresenceNudged.size > 0 ? 0 : undefined)
    }
  }

  /**
   * An end observed for `run`. Before acting, one fenced read of the owning host makes sure the
   * pane has not already moved on to a replacement agent (same name included): that run is adopted
   * instead, and an unreadable host leaves the end unproven.
   */
  protected handleAgentRunEnd(run: AgentExitRun, observedAtMs: number): void {
    if (run.endHandled || !this.agentExitRuns.isCurrent(run)) {
      return
    }
    run.endHandled = true
    const inspect = this.ptyController?.inspectProcess
    if (!inspect) {
      return
    }
    void inspect
      .call(
        this.ptyController,
        run.ptyId,
        run.incarnationId ? { expectedIncarnationId: run.incarnationId } : {}
      )
      .catch(() => null)
      .then(async (inspection) => {
        if (
          !this.agentExitRuns.isCurrent(run) ||
          this.readAgentExitPty(run.ptyId)?.incarnationId !== run.incarnationId
        ) {
          return
        }
        if (isFencedShellForeground(inspection, run.incarnationId)) {
          this.onAgentRunExitProven(run, observedAtMs)
          return
        }
        const replacement = readRecognizedForegroundAgent(inspection, run.incarnationId)
        if (replacement && replacement.pid !== run.identity?.pid) {
          const identity = await this.bootstrapAgentIdentity(replacement)
          if (this.agentExitRuns.isCurrent(run)) {
            this.agentExitRuns.begin(run.ptyId, {
              incarnationId: run.incarnationId,
              agent: replacement.agent,
              identity,
              source: 'foreground'
            })
            this.scheduleAgentPresenceTick()
          }
          return
        }
        // Why reopen: unverifiable now is not an exit; a later signal may prove it.
        run.endHandled = false
        run.failedProbes += 1
      })
  }
}
