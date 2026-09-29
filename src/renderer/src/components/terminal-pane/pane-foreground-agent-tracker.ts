import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-process-recognition'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { createPaneForegroundProcessReader } from './pane-foreground-process-reader'
import { createPaneAgentExitMarks, type ConfirmedShellAgentExit } from './pane-agent-exit-marks'
import {
  FOREGROUND_CONFIRM_RETRY_DELAYS_MS,
  isAgentExitBlind
} from '../../../../shared/foreground-agent-verdict'

export type { ConfirmedShellAgentExit } from './pane-agent-exit-marks'

// Why: settle after exec, then place the final generic retry beyond sequential
// 3s PowerShell and WMIC enrichment scans.
const COMMAND_SETTLE_MS = 350
const VISIBLE_PTY_SETTLE_MS = 350
type ForegroundReadReason = 'command' | 'visible-pty' | 'command-finished'
type ShellConfirmReason = Exclude<ForegroundReadReason, 'command'>

type PaneForegroundAgentTrackerDeps = {
  getPtyId: () => string | null
  /** Local panes only — remote/SSH foreground reads are expensive RPCs and
   *  their replayed OSC streams must not produce process evidence. */
  isTrackablePtyId: (ptyId: string) => boolean
  readForegroundProcess: (
    ptyId: string,
    options?: { expectedIncarnationId?: string }
  ) => Promise<string | null | RuntimeTerminalProcessInspection>
  /** Fresh, provider-owned evidence used only when input routing may change. */
  confirmForegroundProcess?: (
    ptyId: string,
    options?: { expectedIncarnationId?: string }
  ) => Promise<string | null | RuntimeTerminalProcessInspection>
  /** Remote authorities must provide fenced evidence; local panes retain the string path. */
  isRemotePtyId?: (ptyId: string) => boolean
  getExpectedIncarnationId?: () => string | null
  publish: (entry: PaneForegroundAgentEntry) => void
  revokeRouting?: () => void
  /** False when main parses the bytes: the pane never sees its shell's 133;C, so main judges marks. */
  seesShellCommandMarks?: () => boolean
  /** True when the pane is otherwise known to run an agent (launchAgent, live
   *  hook status). Lets a restored agent pane confirm — rather than trust — a
   *  133;D before any command-start read has recorded its own evidence. */
  hasKnownAgentIdentity?: () => boolean
  /** Fired when a confirming read proves the foreground genuinely returned to a
   *  shell. Lets callers clear a stale agent-named tab title that the shell never
   *  repaints. A slow boot also shows the shell, so a retired expectation is never an exit. */
  onConfirmedShellForeground?: (
    reason: ShellConfirmReason,
    agentExit: ConfirmedShellAgentExit
  ) => void
  onCommandFinishedUnavailable?: () => void
  onVisibleForegroundSettled?: (outcome: 'agent' | 'shell' | 'inconclusive') => void
}

/**
 * Publishes process-table identity for a pane at OSC 133 command boundaries:
 * one foreground read when a command starts (that is when the foreground
 * changes), and a shell-foreground mark when it finishes. A 133;D is normally
 * the shell-foreground proof; for a pane an agent has owned it is confirmed by a
 * foreground read first, because a full-screen agent's nested command shells
 * leak their own 133;D onto the main PTY.
 */
export function createPaneForegroundAgentTracker(deps: PaneForegroundAgentTrackerDeps): {
  /** True while any read is scheduled or running, whatever its authority. */
  hasReadInFlight: () => boolean
  onVisiblePtyBound: (expectsAgent?: boolean) => boolean
  /** A neutral title followed the agent's own status title; confirm whether it exited. */
  onAgentExitCandidate: () => boolean
  /** `shellMarked`: the shell's own 133;C, not an expectation seeded at spawn or typed input. */
  onCommandStarted: (expectedAgent?: TuiAgent | null, options?: { shellMarked?: boolean }) => void
  /** True when pane identity must remain visible until an async shell confirmation. */
  onCommandFinished: () => boolean
  dispose: () => void
} {
  let disposed = false
  let readTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledReadReason: ForegroundReadReason | null = null
  let activeReadReason: ForegroundReadReason | null = null
  let readGeneration = 0
  // Why: a full-screen agent (Codex, etc.) runs nested command shells whose own
  // OSC 133;D leaks onto the main PTY. For a pane an agent has owned, that D is
  // not proof the prompt returned, so confirm the foreground before clearing.
  let hasForegroundAgentEvidence = false
  // Why: latch launch/hook evidence until confirmation finishes so cleanup
  // cannot remove the identity that authorizes the bounded retry ladder.
  let hasKnownAgentEvidence = false
  let hasAgentExpectation = false
  // True while the pending visible-pty read answers the agent's own idle-to-neutral title.
  let agentTitleExitCandidate = false
  const exitMarks = createPaneAgentExitMarks(deps.seesShellCommandMarks)
  const ptyKey = (id: string): string => `${id}\n${deps.getExpectedIncarnationId?.() ?? ''}`
  const readProcess = createPaneForegroundProcessReader(deps)

  const trackablePtyId = (): string | null => {
    const ptyId = deps.getPtyId()
    return ptyId && deps.isTrackablePtyId(ptyId) ? ptyId : null
  }

  const cancelPendingRead = (): void => {
    readGeneration += 1
    if (readTimer !== null) {
      clearTimeout(readTimer)
      readTimer = null
    }
    scheduledReadReason = null
    activeReadReason = null
    agentTitleExitCandidate = false
  }

  const scheduleRead = (
    delayMs: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): void => {
    const generation = readGeneration
    scheduledReadReason = reason
    readTimer = setTimeout(() => {
      readTimer = null
      scheduledReadReason = null
      activeReadReason = reason
      void readForeground(generation, retryIndex, reason).finally(() => {
        if (generation === readGeneration && activeReadReason === reason) {
          activeReadReason = null
        }
      })
    }, delayMs)
  }

  const hasPendingRead = (): boolean => scheduledReadReason !== null || activeReadReason !== null

  // Why: the store entry outlives this tracker, so any capability a caller retained
  // pending a read must be released by whichever exit ends that read. A superseded
  // read is the one exception — its successor settles for it.
  const releaseRetainedCapability = (hadReadInFlight: boolean): void => {
    if (hadReadInFlight) {
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  const settleAbortedRead = (generation: number): void => {
    if (!disposed && generation === readGeneration) {
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  async function readForeground(
    generation: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): Promise<void> {
    const ptyId = trackablePtyId()
    if (disposed || generation !== readGeneration || !ptyId) {
      settleAbortedRead(generation)
      return
    }
    const requiresRoutingConfirmation =
      reason === 'command-finished' ||
      hasForegroundAgentEvidence ||
      hasKnownAgentEvidence ||
      hasAgentExpectation
    const { judgement, expectedIncarnationId, remote } = await readProcess(
      ptyId,
      requiresRoutingConfirmation
    )
    const { processName, verdict } = judgement
    // Why: a pane key can be rebound while process inspection is pending; the
    // old PTY's identity must never publish into its replacement session.
    if (
      disposed ||
      generation !== readGeneration ||
      trackablePtyId() !== ptyId ||
      (remote && deps.getExpectedIncarnationId?.() !== expectedIncarnationId)
    ) {
      settleAbortedRead(generation)
      return
    }
    const recognized = verdict === 'live' ? recognizeAgentProcess(processName) : null
    if (recognized) {
      hasForegroundAgentEvidence = true
      exitMarks.agentSeenLive(ptyKey(ptyId))
      hasAgentExpectation = false
      deps.publish({
        agent: recognized.agent,
        shellForeground: false,
        ...(requiresRoutingConfirmation ? { routingTrusted: true } : {})
      })
      if (reason === 'visible-pty') {
        deps.onVisibleForegroundSettled?.('agent')
      }
      return
    }
    // Why: a shell seen here is NOT prompt proof — 133;D cancels pending reads,
    // so a still-live generation means the command is running and the shell is
    // a nested one (sh/bash without integration); marking shell-foreground
    // would suppress live title identity. Only 133;D proves the prompt.
    const retryDelay = FOREGROUND_CONFIRM_RETRY_DELAYS_MS[retryIndex]
    const hasConfirmationExpectation =
      hasForegroundAgentEvidence || hasKnownAgentEvidence || hasAgentExpectation
    // Why: where no read can show this pane's shell, the agent's own title is its exit (base).
    const titleIsExitSignal =
      agentTitleExitCandidate && isAgentExitBlind(judgement, exitMarks.marksCommands(ptyKey(ptyId)))
    // Why: a re-read cannot change a host's structural answer or its fenced shell fact.
    const settledByHost =
      !judgement.canCertifyExit || (remote && verdict === 'exited') || titleIsExitSignal
    const shouldRetryExpectedIdentity =
      hasConfirmationExpectation &&
      !settledByHost &&
      (reason !== 'command-finished' || processName === null)
    const shouldRetry =
      retryDelay !== undefined &&
      (shouldRetryExpectedIdentity ||
        (processName !== null &&
          (reason === 'command' || isAgentForegroundWrapperProcess(processName))))
    if (shouldRetry) {
      // Why: provisional PowerShell may hide a live agent; the bounded ladder
      // spans PowerShell-to-WMIC enrichment without becoming a polling loop.
      scheduleRead(retryDelay, retryIndex + 1, reason)
      return
    }
    if (reason === 'command') {
      if (!processName?.trim()) {
        return
      }
      hasAgentExpectation = false
      if (!hasForegroundAgentEvidence && !hasKnownAgentEvidence) {
        deps.publish({ agent: null, shellForeground: false })
      }
      return
    }
    if (reason === 'visible-pty') {
      if (
        (hasForegroundAgentEvidence || hasKnownAgentEvidence) &&
        (verdict === 'exited' || titleIsExitSignal)
      ) {
        confirmShellForeground(reason, ptyId)
        deps.onVisibleForegroundSettled?.('shell')
      } else {
        deps.onVisibleForegroundSettled?.('inconclusive')
      }
      return
    }
    // Why: 133;D is the shell's own mark; where no read can ever show a shell it retires the agent.
    if (verdict === 'exited' || (!judgement.canCertifyExit && hasConfirmationExpectation)) {
      confirmShellForeground(reason, ptyId)
      return
    }
    deps.onCommandFinishedUnavailable?.()
    if (processName !== null) {
      // Why: this read may have replaced a cancelled visible-pty confirmation.
      // It publishes nothing, so without settling here the capability it was
      // asked to revalidate would be retained with no read left to clear it.
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  const confirmShellForeground = (reason: ShellConfirmReason, ptyId: string): void => {
    // Why: an exit needs an agent seen in this pane, or the shell's own 133;D ending its command.
    const agentExit = exitMarks.classifyConfirmedShell(ptyKey(ptyId), reason)
    // Why: reset the evidence so the pane's ordinary shell commands go back to
    // the no-RPC finished path.
    hasForegroundAgentEvidence = false
    hasKnownAgentEvidence = false
    hasAgentExpectation = false
    deps.publish({ agent: null, shellForeground: true })
    // Why: confirmed exit — let callers clear a stale agent title the shell
    // won't repaint (a plain `codex`/`grok` leaves its OSC title behind).
    deps.onConfirmedShellForeground?.(reason, agentExit)
  }

  const bindVisiblePty = (expectsAgent: boolean, agentObserved: boolean): boolean => {
    // Why: command-start and command-finished reads own the exit decision;
    // visibility recovery is lower-authority and must never cancel them.
    if (
      scheduledReadReason === 'command' ||
      activeReadReason === 'command' ||
      scheduledReadReason === 'command-finished' ||
      activeReadReason === 'command-finished'
    ) {
      return false
    }
    const hadReadBeforeVisibleBind = hasPendingRead()
    cancelPendingRead()
    const ptyId = trackablePtyId()
    if (!ptyId) {
      releaseRetainedCapability(hadReadBeforeVisibleBind)
      return false
    }
    if (expectsAgent || deps.hasKnownAgentIdentity?.() === true) {
      hasKnownAgentEvidence = true
    }
    if (agentObserved) {
      hasForegroundAgentEvidence = true
      exitMarks.agentTitleObserved(ptyKey(ptyId))
    }
    // Why: restored/manual agent panes can become visible while Codex is
    // already foreground, so no OSC 133 command-start event will seed the tab icon.
    scheduleRead(VISIBLE_PTY_SETTLE_MS, 0, 'visible-pty')
    return true
  }

  return {
    // Why: onVisiblePtyBound refuses to schedule while a higher-authority
    // command read owns the pane, so "it scheduled nothing" must not be read
    // as "nothing will confirm this pane".
    hasReadInFlight(): boolean {
      return hasPendingRead()
    },
    onVisiblePtyBound(expectsAgent = false) {
      return bindVisiblePty(expectsAgent, false)
    },
    onAgentExitCandidate() {
      // Why: the title tracker saw the agent's own status title, so the agent was observed.
      const scheduled = bindVisiblePty(true, true)
      agentTitleExitCandidate = scheduled
      return scheduled
    },
    onCommandStarted(expectedAgent = null, options = {}) {
      const hadReadBeforeCommandStart = hasPendingRead()
      cancelPendingRead()
      const ptyId = trackablePtyId()
      exitMarks.commandStarted(options.shellMarked && ptyId ? ptyKey(ptyId) : null)
      if (!ptyId) {
        releaseRetainedCapability(hadReadBeforeCommandStart)
        return
      }
      deps.revokeRouting?.()
      const alreadyHasKnownIdentity = deps.hasKnownAgentIdentity?.() === true
      hasAgentExpectation = expectedAgent !== null
      if (alreadyHasKnownIdentity) {
        hasKnownAgentEvidence = true
      }
      // Why: every new command invalidates the previous byte-routing authority.
      // Launch/hook identity remains only an expectation until fresh evidence.
      // Remote marker bytes are turn boundaries only; do not mutate a remote
      // identity from an OSC stream before the host evidence read completes.
      if (
        deps.isRemotePtyId?.(ptyId) !== true &&
        !hasForegroundAgentEvidence &&
        !hasKnownAgentEvidence
      ) {
        deps.publish({ agent: null, shellForeground: false })
      }
      scheduleRead(COMMAND_SETTLE_MS, 0, 'command')
    },
    onCommandFinished() {
      const ptyId = trackablePtyId()
      exitMarks.commandFinished(ptyId ? ptyKey(ptyId) : null)
      if (deps.hasKnownAgentIdentity?.() === true) {
        hasKnownAgentEvidence = true
      }
      // Why: a rapid 133;C→133;D pair cancels the command-start read before it
      // can identify the foreground — that pair is exactly a leaked nested-shell
      // command under a full-screen agent (or a fast real shell command), so on a
      // no-identity pane confirm it rather than trusting the D as a prompt return.
      // ANY in-flight read counts: a command-start read, a prior confirming read
      // (user shell integrations double up Orca's OSC 133), or the reattach/visible
      // recovery probe. All three are attempts to establish this pane's identity, so
      // a D that cancels one must re-confirm — never fast-path to shell, which the
      // sampleVisiblePaneForegroundAgent gate would then latch, permanently hiding
      // an idle reattached agent's icon (the "codex reattached at rest" bug).
      const hadReadBeforeCommandFinish = hasPendingRead()
      cancelPendingRead()
      if (!ptyId) {
        releaseRetainedCapability(hadReadBeforeCommandFinish)
        return false
      }
      // Why: trust the 133;D and mark shell without an RPC only when nothing hints
      // at an agent — no prior agent evidence, no launch/hook identity, and no
      // identity read racing this finish.
      if (!hasForegroundAgentEvidence && !hasKnownAgentEvidence && !hasAgentExpectation) {
        if (deps.isRemotePtyId?.(ptyId) !== true) {
          deps.publish({ agent: null, shellForeground: true })
        }
        return false
      }
      // Why: confirm the foreground before clearing — if the agent still owns it,
      // the read republishes its identity; only a genuine shell result clears it.
      scheduleRead(COMMAND_SETTLE_MS, 0, 'command-finished')
      return true
    },
    dispose() {
      const hadReadAtDispose = hasPendingRead()
      disposed = true
      cancelPendingRead()
      releaseRetainedCapability(hadReadAtDispose)
    }
  }
}
