import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import { isSameAgentProcess, type AgentProcessIdentity } from '../../shared/agent-process-presence'
import { AgentExitRunRegistry, readRecognizedForegroundAgent } from './agent-exit-run-registry'
import { bootstrapAgentProcessIdentity } from './agent-process-identity-bootstrap'

// Why three tries (now, 1 s, 5 s): a just-typed launch needs a moment to exec; then stop.
const AGENT_IDENTITY_DISCOVERY_DELAYS_MS = [0, 1_000, 5_000] as const

export type AgentExitPtyRecord = {
  incarnationId: string | null
  connected: boolean
  connectionId: string | null
  isWsl: boolean | null
}

/**
 * Learns the exact process of an agent run no hook identified (Codex, hooks off): one fenced,
 * incarnation-matched foreground capture that recognizes the agent, converted to the canonical
 * PID/start identity only when both readings name the same process. At most three captures per
 * run until another change signal; never a periodic table scan.
 */
export class OrcaRuntimeWithAgentIdentityDiscovery extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  protected readonly agentExitRuns = new AgentExitRunRegistry()
  private readonly agentIdentityDiscoveryByPtyId = new Map<
    string,
    { key: string; timer: ReturnType<typeof setTimeout> | null }
  >()
  // Why declared: defined later in the runtime chain, which this split class cannot import.
  declare protected getPtyRecordForPaneKey: (paneKey: string) => { ptyId: string } | null

  /** Overridden by the proof layer: an identified run may now be watched. */
  protected scheduleAgentPresenceTick(_delayMs?: number): void {}

  onPtyExit(...args: Parameters<OrcaRuntimeWithSerializeAgentPromptSubmission['onPtyExit']>) {
    const result = super.onPtyExit(...args)
    this.forgetAgentExitRun(args[0])
    return result
  }

  protected forgetAgentExitRun(ptyId: string): void {
    this.agentExitRuns.forget(ptyId)
    const discovery = this.agentIdentityDiscoveryByPtyId.get(ptyId)
    if (discovery?.timer) {
      clearTimeout(discovery.timer)
    }
    this.agentIdentityDiscoveryByPtyId.delete(ptyId)
  }

  protected bootstrapAgentIdentity(captured: {
    pid: number
    startTime: string
  }): Promise<AgentProcessIdentity | null> {
    return bootstrapAgentProcessIdentity(captured)
  }

  protected readAgentExitPty(ptyId: string): AgentExitPtyRecord | null {
    const record = this.ptysById.get(ptyId)
    return record?.connected ? record : null
  }

  /** This host can read the agent's PID namespace itself (local daemon or in-process, POSIX). */
  protected canProbeAgentProcessLocally(record: AgentExitPtyRecord): boolean {
    return record.connectionId === null && record.isWsl !== true && process.platform !== 'win32'
  }

  protected startAgentIdentityDiscovery(ptyId: string): void {
    const record = this.readAgentExitPty(ptyId)
    if (
      !record ||
      !this.ptyController?.inspectProcess ||
      !this.canProbeAgentProcessLocally(record)
    ) {
      return
    }
    const key = `${record.incarnationId ?? ''}|${this.agentExitRuns.current(ptyId)?.runId ?? 0}`
    if (this.agentIdentityDiscoveryByPtyId.get(ptyId)?.key === key) {
      return
    }
    const state = { key, timer: null as ReturnType<typeof setTimeout> | null }
    this.agentIdentityDiscoveryByPtyId.set(ptyId, state)
    const attempt = (index: number): void => {
      state.timer = null
      void this.discoverAgentIdentity(ptyId, record.incarnationId).then((done) => {
        const delay = AGENT_IDENTITY_DISCOVERY_DELAYS_MS[index + 1]
        if (
          !done &&
          delay !== undefined &&
          this.agentIdentityDiscoveryByPtyId.get(ptyId) === state
        ) {
          state.timer = setTimeout(() => attempt(index + 1), delay)
          state.timer.unref?.()
        }
      })
    }
    attempt(0)
  }

  /** True when discovery is settled (found, or nothing more to learn for this incarnation). */
  private async discoverAgentIdentity(
    ptyId: string,
    incarnationId: string | null
  ): Promise<boolean> {
    const inspect = this.ptyController?.inspectProcess
    const stillThisPty = (): boolean =>
      this.readAgentExitPty(ptyId)?.incarnationId === incarnationId
    if (!inspect || !stillThisPty()) {
      return true
    }
    const inspection = await inspect
      .call(
        this.ptyController,
        ptyId,
        incarnationId ? { expectedIncarnationId: incarnationId } : {}
      )
      .catch(() => null)
    const captured = readRecognizedForegroundAgent(inspection, incarnationId)
    if (!captured || !stillThisPty()) {
      return !stillThisPty()
    }
    const identity = await this.bootstrapAgentIdentity(captured)
    if (!identity || !stillThisPty()) {
      return !stillThisPty()
    }
    const run = this.agentExitRuns.current(ptyId)
    if (
      run &&
      !run.identity &&
      !run.endHandled &&
      (run.agent ?? captured.agent) === captured.agent
    ) {
      run.identity = identity
      run.agent = captured.agent
    } else if (!run?.identity || !isSameAgentProcess(run.identity, identity)) {
      this.agentExitRuns.begin(ptyId, {
        incarnationId,
        agent: captured.agent,
        identity,
        source: 'foreground'
      })
    }
    this.scheduleAgentPresenceTick()
    return true
  }
}
