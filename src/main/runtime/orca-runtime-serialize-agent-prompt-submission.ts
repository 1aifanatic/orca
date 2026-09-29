// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { startSpan } from '../observability/tracer'
import { selectFreshExplicitAgentStatus } from './runtime-hook-agent-row-selection'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './orca-runtime-controller-knows-pty-is-live'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { hasCompatibleAgentTitleIdentity } from '../../shared/agent-title-owner'
import type { PtyForegroundProcessRead } from './runtime-terminal-contracts'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { readAgentPromptWaitText } from './agent-prompt-submission-verification'
import type { AgentStatus } from '../../shared/agent-detection'

export class OrcaRuntimeWithSerializeAgentPromptSubmission extends OrcaRuntimeWithControllerKnowsPtyIsLive {
  protected async serializeAgentPromptSubmission<T>(
    ptyId: string,
    generation: number,
    submit: () => Promise<T>
  ): Promise<T> {
    const queueKey = `${ptyId}\u0000${generation}`
    const previous = this.agentPromptSubmissionTailByPtyId.get(queueKey) ?? Promise.resolve()
    const submission = previous.catch(() => undefined).then(submit)
    const tail = submission.then(
      () => undefined,
      () => undefined
    )
    this.agentPromptSubmissionTailByPtyId.set(queueKey, tail)
    try {
      return await submission
    } finally {
      if (this.agentPromptSubmissionTailByPtyId.get(queueKey) === tail) {
        this.agentPromptSubmissionTailByPtyId.delete(queueKey)
      }
    }
  }

  getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    return this.terminalAgentStatus.getStatus(handle)
  }

  protected getTerminalAgentStatusPtyId(handle: string): string {
    return this.terminalAgentStatus.getPtyId(handle)
  }

  protected getTerminalAgentStatusSnapshot(
    handle: string,
    expectedPtyId: string,
    waitTextOverride?: string
  ): RuntimeTerminalAgentStatusSnapshot {
    const snapshot = this.terminalAgentStatus.getSnapshot(handle, expectedPtyId)
    return waitTextOverride === undefined ? snapshot : { ...snapshot, waitText: waitTextOverride }
  }

  protected shouldDelayPtyBackedMobileSnapshotForForegroundAgent(
    pty: RuntimePtyWorktreeRecord,
    title: string
  ): boolean {
    return (
      !pty.launchAgent && pty.foregroundAgent === null && hasCompatibleAgentTitleIdentity(title)
    )
  }

  protected readPtyForegroundProcessFromController(
    ptyId: string,
    afterTitleObservation = 0
  ): Promise<PtyForegroundProcessRead> | null {
    return this.ptyForegroundAgent.confirm(ptyId, afterTitleObservation)
  }

  protected confirmPtyAgentExit(ptyId: string, recoverCompletedHook = false): void {
    const pty = this.ptysById.get(ptyId)
    const handle = this.handleByPtyId.get(ptyId)
    if (
      recoverCompletedHook &&
      (!handle || this.getFreshExplicitAgentStatusForPty(handle, ptyId)?.status !== 'idle')
    ) {
      return
    }
    const incarnationId = pty?.incarnationId
    const generation = recoverCompletedHook ? this.getPtyLifecycleGeneration(ptyId) : null
    const titleObservedAt = pty?.lastOscTitleAt ?? null
    const foregroundRead = this.readPtyForegroundProcessFromController(ptyId, titleObservedAt ?? 0)
    if (!pty?.connected || !foregroundRead) {
      this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
      return
    }
    void foregroundRead.then((result) => {
      const current = this.ptysById.get(ptyId)
      if (
        current !== pty ||
        !current.connected ||
        current.incarnationId !== incarnationId ||
        (recoverCompletedHook && this.getPtyLifecycleGeneration(ptyId) !== generation)
      ) {
        return
      }
      if (current.lastOscTitleAt !== titleObservedAt && current.lastAgentStatus !== null) {
        return
      }
      if (
        recoverCompletedHook &&
        (!current.lastAgentStatusObservedLive ||
          this.getFreshExplicitAgentStatusForPty(handle, ptyId)?.status !== 'idle')
      ) {
        return
      }
      if (recoverCompletedHook && current.lastOscTitleAt !== titleObservedAt) {
        this.confirmPtyAgentExit(ptyId, true)
        return
      }
      const { verdict, processName } = result.judgement
      if (result.controller === this.ptyController && verdict === 'live') {
        // Codex's final native spinner can arrive after its done hook, then clear to the cwd.
        const confirmedStatus =
          recoverCompletedHook && recognizeAgentProcess(processName)?.agent === 'codex'
            ? 'idle'
            : undefined
        const restoredStatus = this.ptyTitleTrackersByPtyId
          .get(ptyId)
          ?.tracker.restoreLastAgentExit(confirmedStatus)
        if (restoredStatus !== null && restoredStatus !== undefined) {
          current.lastAgentStatus = restoredStatus
          if (restoredStatus === 'idle') {
            this.resolvePtyTuiIdleWaiters(current, ptyId)
          }
          for (const leaf of this.getLeavesForPty(ptyId)) {
            if (leaf.lastAgentStatus !== null) {
              continue
            }
            // Why: the foreground agent disproved the neutral title's exit signal; keep runtime delivery state aligned with the restored tracker.
            leaf.lastAgentStatus = restoredStatus
            if (restoredStatus === 'idle') {
              this.resolveTuiIdleWaiters(leaf)
              // Why gated like every other delivery edge: a neutral-title restoration can
              // reinstate `idle` from a name-only title, which is not evidence a turn ended.
              if (this.checkDeliverySettledAndArmRecheck(leaf)) {
                this.deliverPendingMessagesForLeaf(leaf)
              }
            }
          }
        }
        return
      }
      // Why: an SSH relay on Windows neither reads the foreground nor marks commands (OSC 133),
      // so there the agent's own idle-to-neutral title is the only exit signal (base behaviour).
      const titleIsOnlyExitSignal =
        verdict === 'unverifiable' &&
        !result.judgement.canCertifyExit &&
        Boolean(current.connectionId)
      if (
        !recoverCompletedHook &&
        result.controller === this.ptyController &&
        (verdict === 'exited' || titleIsOnlyExitSignal)
      ) {
        if (titleIsOnlyExitSignal) {
          this.ptyForegroundAgent.markExited(ptyId)
        }
        this.publishPtyAgentExit(
          ptyId,
          'title-exit-candidate',
          titleIsOnlyExitSignal ? 'agent-title' : 'foreground-shell'
        )
      } else {
        this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
      }
    })
  }

  /**
   * The shell's own 133;D ends an agent this PTY held once a read shows a shell, or at once on a
   * host that can never show one. A PTY that held no agent pays no read.
   */
  protected confirmPtyAgentExitAtCommandFinished(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    // Why launchAgent counts: Orca's shell integration emits 133;D only after the command it ran.
    if (!pty?.connected || (!pty.launchAgent && !pty.foregroundAgent && !pty.lastAgentStatus)) {
      return
    }
    const incarnationId = pty.incarnationId
    // Why +0.5: newer than every title seen so far and older than the next, so a read begun
    // before this 133;D is never reused and a later title never reuses this one.
    const afterBoundary = this.titleObservationSequence + 0.5
    void this.readPtyForegroundProcessFromController(ptyId, afterBoundary)?.then((result) => {
      const current = this.ptysById.get(ptyId)
      const { verdict, canCertifyExit } = result.judgement
      if (
        current !== pty ||
        !current.connected ||
        current.incarnationId !== incarnationId ||
        result.controller !== this.ptyController ||
        verdict === 'live' ||
        (verdict === 'unverifiable' && canCertifyExit)
      ) {
        return
      }
      if (verdict === 'unverifiable') {
        this.ptyForegroundAgent.markExited(ptyId)
      }
      // Why: a stale agent title would otherwise make every later 133;D look like an agent's.
      current.lastAgentStatus = null
      this.publishPtyAgentExit(
        ptyId,
        'command-finished',
        verdict === 'exited' ? 'foreground-shell' : 'command-finished'
      )
    })
  }

  private publishPtyAgentExit(
    ptyId: string,
    reason: 'title-exit-candidate' | 'command-finished',
    evidence: 'foreground-shell' | 'command-finished' | 'agent-title'
  ): void {
    startSpan('terminal.agent-exit-decision', {
      attributes: {
        reason,
        evidenceSource:
          evidence === 'foreground-shell'
            ? 'host-foreground-confirmation'
            : evidence === 'agent-title'
              ? 'osc-title'
              : 'osc-133',
        verdict: 'exited'
      }
    }).end()
    this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited', evidence })
  }

  /**
   * Schedules an asynchronous query to check which agent process is currently
   * running in the foreground of a PTY.
   */
  protected refreshPtyForegroundAgent(ptyId: string): void {
    void this.ptyForegroundAgent.refresh(ptyId)
  }

  protected getPendingForegroundAgentRefreshForTitle(
    ptyId: string,
    titleObservedAt: number
  ): Promise<boolean> | undefined {
    return this.ptyForegroundAgent.getPending(ptyId, titleObservedAt)
  }

  protected delayPtyBackedMobileSnapshotForForegroundAgent(
    ptyId: string,
    titleObservedAt: number,
    foregroundRefresh: Promise<boolean>
  ): void {
    this.ptyForegroundAgent.delaySnapshot(ptyId, titleObservedAt, foregroundRefresh)
  }

  protected getFreshExplicitAgentStatusForHandle(
    handle: string,
    paneKeyOverride?: string | null
  ): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    stateStartedAt: number
  } | null {
    return selectFreshExplicitAgentStatus({
      handle,
      paneKey: paneKeyOverride ?? this.getPaneKeyForTerminalHandle(handle),
      hookRows: this.getAgentStatusSnapshotFn?.() ?? []
    })
  }

  protected getAgentPromptActivity(
    handle: string,
    ptyId: string,
    waitTextCache?: AgentPromptWaitTextCache
  ): AgentPromptActivity {
    this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    const outputSequence = this.getPtyOutputSequence(ptyId)
    const explicit = this.getFreshExplicitAgentStatusForPty(handle, ptyId)
    const explicitFloor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
    const lifecycle = this.agentPromptLifecycleByPtyId.get(ptyId)
    const ptyStatus =
      lifecycle || explicitFloor === undefined
        ? (this.ptysById.get(ptyId)?.lastAgentStatus ?? null)
        : null
    const lifecycleIsNewer =
      lifecycle &&
      (!explicit ||
        lifecycle.updatedAt > explicit.updatedAt ||
        (lifecycle.updatedAt === explicit.updatedAt && lifecycle.status === 'permission'))
    const waitText = waitTextCache
      ? readAgentPromptWaitText(
          waitTextCache,
          outputSequence,
          () => this.getTerminalAgentStatusSnapshot(handle, ptyId).waitText
        )
      : undefined
    const terminal = this.getTerminalAgentStatusSnapshot(handle, ptyId, waitText)
    const status = this.hasAuthoritativeTerminalWaitPermission(terminal, explicit, lifecycle)
      ? 'permission'
      : lifecycleIsNewer
        ? lifecycle.status
        : (explicit?.status ?? ptyStatus ?? null)
    return {
      generation: this.getPtyLifecycleGeneration(ptyId),
      permissionSequence: this.agentPromptPermissionSequenceByPtyId.get(ptyId) ?? 0,
      workingSequence: lifecycle?.workingSequence ?? 0,
      explicitWorkingStartedAt: explicit?.status === 'working' ? explicit.stateStartedAt : null,
      outputSequence,
      status
    }
  }

  protected hasAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ): boolean {
    return (
      this.resolveAuthoritativeTerminalWaitPermission(terminal, explicitStatus, lifecycle) !== null
    )
  }

  protected getFreshExplicitAgentStatusForPty(handle: string, ptyId: string) {
    const explicit = this.getFreshExplicitAgentStatusForHandle(handle)
    const floor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
    return explicit && (floor === undefined || explicit.updatedAt > floor) ? explicit : null
  }
}
