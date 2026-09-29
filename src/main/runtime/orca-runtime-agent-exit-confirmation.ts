import { startSpan } from '../observability/tracer'
import { takeShellCommandFinishedAgentHold } from './shell-command-agent-hold'
import { AgentExitCandidateRechecks } from './agent-exit-candidate-recheck'
import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'

/** Publishes agent exits and owns the bounded re-read of a title candidate no read could answer. */
export class OrcaRuntimeWithAgentExitConfirmation extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  protected readonly agentExitRechecks = new AgentExitCandidateRechecks((ptyId, recheck) =>
    this.confirmPtyAgentExit(ptyId, false, recheck)
  )

  /**
   * The shell's own 133;D ends an agent this PTY held once a read shows a shell, or at once on a
   * host that can never show one. A PTY that held no agent pays no read.
   */
  protected confirmPtyAgentExitAtCommandFinished(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    const heldAgent = pty ? takeShellCommandFinishedAgentHold(pty) : false
    if (!pty?.connected || !heldAgent) {
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

  protected publishPtyAgentExit(
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
    this.agentExitRechecks.clear(ptyId)
    this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited', evidence })
  }

  markPtyLivenessLive(ptyId: string, observedNoLaterThan?: number): void {
    super.markPtyLivenessLive(ptyId, observedNoLaterThan)
    this.agentExitRechecks.recheckAfterContact(
      ptyId,
      this.ptysById.get(ptyId)?.incarnationId ?? null
    )
  }

  registerPty(
    ...args: Parameters<OrcaRuntimeWithSerializeAgentPromptSubmission['registerPty']>
  ): void {
    super.registerPty(...args)
    // Why: a reattach is renewed contact with the host that could not answer.
    this.agentExitRechecks.recheckAfterContact(
      args[0],
      this.ptysById.get(args[0])?.incarnationId ?? null
    )
  }

  protected disposePtyTitleTracker(ptyId: string): void {
    super.disposePtyTitleTracker(ptyId)
    this.agentExitRechecks.clear(ptyId)
  }
}
