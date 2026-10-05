import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import { NativeChatInputGuard } from './native-chat-input-guard'
import { classifyAgentExitInspection } from './agent-exit-proof'
import {
  collectAgentExitChatViewCandidates,
  findAgentExitChatViewCandidatesForPty,
  type AgentExitChatViewCandidate
} from './agent-exit-chat-view-candidates'
import { readHeadlessChatPairState } from './session-tab-chat-pair'
import { normalizeTerminalChatPair } from '../../shared/terminal-tab-view-mode'
import { terminalLayoutNodeLeafIds } from '../../shared/native-chat-leaf-ownership'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

// Why 15 s: an exit the title and hooks never reported is still found while the user reads.
const AGENT_EXIT_RECONCILE_INTERVAL_MS = 15_000
// Why: a pane first seen moments ago may be typing its launch command; no child yet is not an exit.
const AGENT_EXIT_LAUNCH_GRACE_MS = 30_000

type AgentExitObservation = {
  ptyId: string
  record: unknown
  incarnationId: string | null
  evidenceSeq: number
}

/**
 * The host's own handling of a proven agent exit (the agent child, while its shell lives on): the
 * chat tab turns terminal on every device, the pane's launch hint is retired, and chat composer
 * writes to that PTY are refused. Proof is the canonical hook owner check (`exited`) or a fresh
 * execution-host inspection with no child left under the shell; anything weaker changes nothing.
 */
export class OrcaRuntimeWithAgentExitChatView extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  protected readonly nativeChatInputGuard = new NativeChatInputGuard()
  private readonly agentEvidenceSeqByPtyId = new Map<string, number>()
  private readonly agentSightedIncarnationByPtyId = new Map<string, string | null>()
  private readonly agentExitCandidateSeenAt = new Map<string, number>()
  private readonly agentExitChecksInFlight = new Set<string>()
  private readonly agentExitProvenAtByPtyId = new Map<string, number>()
  private agentExitReconcileTimer: ReturnType<typeof setInterval> | null = null
  // Why declared: defined later in the runtime chain, which this split class cannot import.
  declare protected getAvailableAuthoritativeWindow: () => unknown
  declare protected getPtyRecordForPaneKey: (paneKey: string) => { ptyId: string } | null

  onPtyExit(...args: Parameters<OrcaRuntimeWithSerializeAgentPromptSubmission['onPtyExit']>) {
    const result = super.onPtyExit(...args)
    this.forgetNativeChatAgentExitState(args[0])
    return result
  }

  /**
   * The title showed the agent exit. The legacy fact path above keeps its own rules (it may fire on
   * silence); only the proof below retires chat, sharing the same in-flight hook owner probe.
   */
  protected confirmPtyAgentExit(ptyId: string, recoverCompletedHook = false): void {
    super.confirmPtyAgentExit(ptyId, recoverCompletedHook)
    if (!recoverCompletedHook) {
      this.noteAgentSightedForExitProof(ptyId)
      this.checkAgentExitWithExecutionHost(ptyId)
    }
  }

  protected storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const stamped = super.storeMobileSessionSnapshot(worktreeId, snapshot)
    this.ensureAgentExitReconcile()
    return stamped
  }

  /** Any agent evidence on the PTY: the agent runs (again), so new chat actions may write. */
  protected noteNativeChatAgentEvidence(ptyId: string): void {
    this.agentEvidenceSeqByPtyId.set(ptyId, (this.agentEvidenceSeqByPtyId.get(ptyId) ?? 0) + 1)
    this.agentSightedIncarnationByPtyId.set(ptyId, this.ptysById.get(ptyId)?.incarnationId ?? null)
    this.nativeChatInputGuard.clearExit(ptyId)
    this.agentExitProvenAtByPtyId.delete(ptyId)
  }

  protected forgetNativeChatAgentExitState(ptyId: string): void {
    this.nativeChatInputGuard.forget(ptyId)
    this.agentEvidenceSeqByPtyId.delete(ptyId)
    this.agentSightedIncarnationByPtyId.delete(ptyId)
    this.agentExitProvenAtByPtyId.delete(ptyId)
  }

  /** The title showed this incarnation's agent, so a later empty shell is its exit, not its launch. */
  protected noteAgentSightedForExitProof(ptyId: string): void {
    this.agentSightedIncarnationByPtyId.set(ptyId, this.ptysById.get(ptyId)?.incarnationId ?? null)
  }

  /**
   * A hook status row changed for `paneKey`: newer hook status than a proven exit is new agent
   * evidence; any change also checks a chat pane's agent now, instead of at the next pass.
   */
  noteAgentStatusRowMutation(paneKey: string): void {
    const pty = this.getPtyRecordForPaneKey(paneKey)
    if (!pty) {
      return
    }
    const provenAt = this.agentExitProvenAtByPtyId.get(pty.ptyId)
    const handle = this.handleByPtyId.get(pty.ptyId)
    const explicit = handle ? this.getFreshExplicitAgentStatusForPty(handle, pty.ptyId) : null
    if (provenAt !== undefined && explicit && explicit.updatedAt > provenAt) {
      this.noteNativeChatAgentEvidence(pty.ptyId)
      return
    }
    this.checkAgentExitForChatCandidate(pty.ptyId)
  }

  /** Checks now only when the PTY backs a pane clients may show as chat; others cost nothing. */
  protected checkAgentExitForChatCandidate(ptyId: string): void {
    if (this.listAgentExitReconcileCandidates().some((c) => c.ptyId === ptyId)) {
      this.checkAgentExitWithExecutionHost(ptyId)
    }
  }

  protected observeAgentExit(ptyId: string): AgentExitObservation | null {
    const record = this.ptysById.get(ptyId)
    if (!record) {
      return null
    }
    return {
      ptyId,
      record,
      incarnationId: record.incarnationId ?? null,
      evidenceSeq: this.agentEvidenceSeqByPtyId.get(ptyId) ?? 0
    }
  }

  /** False once the PTY was replaced, re-incarnated or showed new agent evidence since `observed`. */
  private agentExitObservationStillCurrent(observed: AgentExitObservation): boolean {
    const current = this.ptysById.get(observed.ptyId)
    return (
      current !== undefined &&
      current === observed.record &&
      current.connected &&
      (current.incarnationId ?? null) === observed.incarnationId &&
      (this.agentEvidenceSeqByPtyId.get(observed.ptyId) ?? 0) === observed.evidenceSeq
    )
  }

  /** The canonical hook owner check proved the agent gone (`exited`). */
  protected recordCanonicalAgentExit(observed: AgentExitObservation | null): void {
    if (observed && this.agentExitObservationStillCurrent(observed)) {
      this.commitProvenAgentExit(observed)
    }
  }

  /**
   * Asks the execution host whether anything still runs under the PTY's shell; only `no children`
   * for the same incarnation, after the agent was seen or past the launch grace, proves an exit.
   */
  protected checkAgentExitWithExecutionHost(ptyId: string): void {
    const inspect = this.ptyController?.inspectProcess
    const observed = this.observeAgentExit(ptyId)
    if (!inspect || !observed || this.agentExitChecksInFlight.has(ptyId)) {
      return
    }
    if (this.nativeChatInputGuard.isExited(ptyId, observed.incarnationId)) {
      return
    }
    this.agentExitChecksInFlight.add(ptyId)
    void (async () => {
      try {
        const presence = await this.recheckHookAgentPresenceForPty(ptyId)
        if (presence === 'exited') {
          this.recordCanonicalAgentExit(observed)
          return
        }
        if (presence === 'live' || !this.agentExitObservationStillCurrent(observed)) {
          return
        }
        const inspection = await inspect
          .call(this.ptyController, ptyId, {
            ...(observed.incarnationId ? { expectedIncarnationId: observed.incarnationId } : {}),
            scanChildProcesses: true
          })
          .catch(() => null)
        if (!this.agentExitObservationStillCurrent(observed)) {
          return
        }
        const verdict = classifyAgentExitInspection(inspection, observed.incarnationId)
        if (verdict === 'running') {
          this.agentSightedIncarnationByPtyId.set(ptyId, observed.incarnationId)
        } else if (verdict === 'exited' && this.agentLaunchSettledForExitProof(observed)) {
          this.commitProvenAgentExit(observed)
        }
      } finally {
        this.agentExitChecksInFlight.delete(ptyId)
      }
    })()
  }

  private agentLaunchSettledForExitProof(observed: AgentExitObservation): boolean {
    if (this.agentSightedIncarnationByPtyId.get(observed.ptyId) === observed.incarnationId) {
      return true
    }
    const seenAt = this.agentExitCandidateSeenAt.get(observed.ptyId)
    return seenAt !== undefined && Date.now() - seenAt >= AGENT_EXIT_LAUNCH_GRACE_MS
  }

  private commitProvenAgentExit(observed: AgentExitObservation): void {
    if (this.nativeChatInputGuard.isExited(observed.ptyId, observed.incarnationId)) {
      return
    }
    // Why first: refusing stale composer input must not wait on any view bookkeeping below.
    this.nativeChatInputGuard.confirmExit(observed.ptyId, observed.incarnationId)
    this.agentExitProvenAtByPtyId.set(observed.ptyId, Date.now())
    const candidates = findAgentExitChatViewCandidatesForPty(
      this.mobileSessionTabsByWorktree.entries(),
      observed.ptyId
    )
    this.retirePtyAgentLaunchAuthority(observed.ptyId)
    for (const candidate of candidates) {
      this.retireExitedAgentChatView(candidate)
    }
    this.touchMobileSessionSnapshotsForPty(observed.ptyId)
  }

  private retireExitedAgentChatView(candidate: AgentExitChatViewCandidate): void {
    if (this.getAvailableAuthoritativeWindow()) {
      void this.relayExitedAgentChatView(candidate)
      return
    }
    const session = this.getWorkspaceSessionForWorktree(candidate.worktreeId)
    const state = readHeadlessChatPairState(
      session,
      this.mobileSessionTabsByWorktree.get(candidate.worktreeId),
      candidate.worktreeId,
      candidate.parentTabId
    )
    if (!state) {
      return
    }
    const leafIds = terminalLayoutNodeLeafIds(state.root)
    const soleLeaf = state.hasLayout ? leafIds.length === 1 : true
    const boundPtyId = state.hasLayout
      ? state.layout?.ptyIdsByLeafId?.[candidate.leafId]
      : session?.tabsByWorktree[candidate.worktreeId]?.find(
          (tab) => tab.id === candidate.parentTabId
        )?.ptyId
    // Why compare-and-set: a newer user switch or a rebound pane must never be undone by this exit.
    if (boundPtyId !== undefined && boundPtyId !== null && boundPtyId !== candidate.ptyId) {
      return
    }
    const pair = normalizeTerminalChatPair(state.pair, state.root)
    const ownsChat =
      pair.viewMode === 'chat' &&
      (pair.chatLeafId ? pair.chatLeafId === candidate.leafId : soleLeaf)
    const hint = soleLeaf ? { launchAgent: null } : {}
    if (ownsChat) {
      this.applyHeadlessChatPairWrite(
        candidate.worktreeId,
        candidate.parentTabId,
        null,
        'terminal',
        hint
      )
    } else if (pair.viewMode === undefined && soleLeaf) {
      this.persistHeadlessSessionTabProps(candidate.worktreeId, candidate.parentTabId, hint)
      this.applyHeadlessSessionTabPropsToSnapshot(candidate.worktreeId, candidate.parentTabId, hint)
    }
  }

  private async relayExitedAgentChatView(candidate: AgentExitChatViewCandidate): Promise<void> {
    try {
      await this.notifier?.setTerminalChatView?.(
        candidate.worktreeId,
        candidate.parentTabId,
        candidate.leafId,
        'terminal',
        undefined,
        { ptyId: candidate.ptyId }
      )
    } catch (error) {
      // Why no retry: the next reconciliation pass re-derives the mismatch from the published tab.
      console.warn('[native-chat] could not retire an exited agent chat view', error)
    }
  }

  /** Coalesced, bounded discovery of exits nothing reported; stops when no candidate remains. */
  protected ensureAgentExitReconcile(): void {
    if (this.agentExitReconcileTimer) {
      return
    }
    if (!this.hasAgentExitReconcileWork()) {
      return
    }
    this.agentExitReconcileTimer = setInterval(
      () => this.runAgentExitReconcilePass(),
      AGENT_EXIT_RECONCILE_INTERVAL_MS
    )
    this.agentExitReconcileTimer.unref?.()
  }

  private hasAgentExitReconcileWork(): boolean {
    // Why: a pass proves nothing without an execution host that can inspect its PTYs.
    return (
      Boolean(this.ptyController?.inspectProcess) &&
      this.listAgentExitReconcileCandidates().length > 0
    )
  }

  private listAgentExitReconcileCandidates(): AgentExitChatViewCandidate[] {
    return collectAgentExitChatViewCandidates(this.mobileSessionTabsByWorktree.entries()).filter(
      (candidate) => {
        const pty = this.ptysById.get(candidate.ptyId)
        return (
          pty !== undefined &&
          pty.connected &&
          !this.nativeChatInputGuard.isExited(candidate.ptyId, pty.incarnationId ?? null)
        )
      }
    )
  }

  protected runAgentExitReconcilePass(): void {
    const candidates = this.listAgentExitReconcileCandidates()
    const now = Date.now()
    const live = new Set(candidates.map((candidate) => candidate.ptyId))
    for (const ptyId of this.agentExitCandidateSeenAt.keys()) {
      if (!live.has(ptyId)) {
        this.agentExitCandidateSeenAt.delete(ptyId)
      }
    }
    if (candidates.length === 0) {
      this.stopAgentExitReconcile()
      return
    }
    for (const ptyId of live) {
      if (!this.agentExitCandidateSeenAt.has(ptyId)) {
        this.agentExitCandidateSeenAt.set(ptyId, now)
      }
      this.checkAgentExitWithExecutionHost(ptyId)
    }
  }

  protected stopAgentExitReconcile(): void {
    if (this.agentExitReconcileTimer) {
      clearInterval(this.agentExitReconcileTimer)
      this.agentExitReconcileTimer = null
    }
  }
}
