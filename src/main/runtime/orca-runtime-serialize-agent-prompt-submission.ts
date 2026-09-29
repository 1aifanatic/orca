// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { selectFreshExplicitAgentStatus } from './runtime-hook-agent-row-selection'
import { ptyMarksShellCommands } from './shell-command-agent-hold'
import { isAgentExitBlind } from '../../shared/foreground-agent-verdict'
import { SPENT_AGENT_EXIT_RECHECK, type AgentExitRecheck } from './agent-exit-candidate-recheck'
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
    afterTitleObservation = 0,
    fresh = true
  ): Promise<PtyForegroundProcessRead> | null {
    return this.ptyForegroundAgent.confirm(ptyId, afterTitleObservation, fresh)
  }

  protected confirmPtyAgentExit(
    ptyId: string,
    recoverCompletedHook = false,
    recheck?: AgentExitRecheck
  ): void {
    const pty = this.ptysById.get(ptyId)
    const handle = this.handleByPtyId.get(ptyId)
    if (
      recoverCompletedHook &&
      (!handle || this.getFreshExplicitAgentStatusForPty(handle, ptyId)?.status !== 'idle')
    ) {
      return
    }
    const incarnationId = pty?.incarnationId
    const generation = this.getPtyLifecycleGeneration(ptyId)
    // Why: a candidate belongs to the process whose title raised it, never a same-id replacement.
    if (
      recheck &&
      (recheck.incarnationId !== (incarnationId ?? null) ||
        recheck.lifecycleGeneration !== generation)
    ) {
      return
    }
    const titleObservedAt = recheck ? recheck.titleObservedAt : (pty?.lastOscTitleAt ?? null)
    const candidateOwner = {
      incarnationId: incarnationId ?? null,
      lifecycleGeneration: generation,
      titleObservedAt
    }
    // Why cached: the per-turn hook recovery only restores `idle`; it never certifies an exit.
    const foregroundRead = this.readPtyForegroundProcessFromController(
      ptyId,
      pty?.lastOscTitleAt ?? 0,
      !recoverCompletedHook
    )
    // Why: no host to ask now; the next contact with it re-reads once.
    const awaitHostContact = (): void => {
      if (pty && !recoverCompletedHook) {
        this.agentExitRechecks.scheduleNext(
          ptyId,
          candidateOwner,
          Math.max(recheck?.attempt ?? 0, SPENT_AGENT_EXIT_RECHECK)
        )
      }
      this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
    }
    if (!pty?.connected || !foregroundRead) {
      awaitHostContact()
      return
    }
    void foregroundRead.then((result) => {
      const current = this.ptysById.get(ptyId)
      if (
        current !== pty ||
        current.incarnationId !== incarnationId ||
        // Why: an exit or provider reset ended the process this read was asked about.
        this.getPtyLifecycleGeneration(ptyId) !== generation
      ) {
        return
      }
      if (!current.connected) {
        awaitHostContact()
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
      if (!recoverCompletedHook) {
        this.agentExitRechecks.clear(ptyId)
      }
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
      const decides = !recoverCompletedHook && result.controller === this.ptyController
      // Why: where no read can show this pane's shell, the agent's own title is its exit (base).
      const blind = isAgentExitBlind(result.judgement, ptyMarksShellCommands(current))
      if (decides && (verdict === 'exited' || blind)) {
        if (blind) {
          this.ptyForegroundAgent.markExited(ptyId)
        }
        this.publishPtyAgentExit(
          ptyId,
          'title-exit-candidate',
          blind ? 'agent-title' : 'foreground-shell'
        )
        return
      }
      // Why: an unanswered read re-derives on the bounded ladder; the candidate stays until then.
      if (
        decides &&
        result.judgement.blindness === undefined &&
        this.agentExitRechecks.scheduleNext(ptyId, candidateOwner, recheck?.attempt ?? 0)
      ) {
        return
      }
      this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
    })
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
