import type { RuntimeTerminalWaitBlockedReason } from '../../../../../../shared/runtime-terminal-contracts'
import { describeTerminalWaitBlockedReason } from '../../../../../../shared/terminal-wait-blocked-reason-legacy-alias'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { WorkspaceTrustDiagnosis } from '../../../../agent-workspace-trust-diagnosis'

/** A worker stopped at the agent's own "trust this folder?" screen, with the cause and the way out. */
export class WorkerStartTrustBlockedError extends Error {
  readonly recovery: string

  constructor(message: string, recovery: string) {
    super(message)
    this.name = 'WorkerStartTrustBlockedError'
    this.recovery = recovery
  }
}

export function isAgentTrustBlockedReason(reason: RuntimeTerminalWaitBlockedReason): boolean {
  return reason === 'agent-trust-workspace' || reason === 'codex-trust-workspace'
}

/**
 * Why (#23847): Orca never answers the agent's dialog for the user, so an
 * unattended worker can only fail here; it must say what Orca tried and how to recover.
 * `agent` is null for a reused terminal, whose agent Orca did not launch.
 */
export function createWorkerStartTrustBlockedError(args: {
  reason: RuntimeTerminalWaitBlockedReason
  agent: TuiAgent | null
  workspacePath: string | null
  diagnosis: WorkspaceTrustDiagnosis | null
}): WorkerStartTrustBlockedError {
  const { agent, diagnosis } = args
  const folder = args.workspacePath ?? 'this workspace'
  const prompt = `Agent startup blocked: ${describeTerminalWaitBlockedReason(args.reason)}. ${agent ?? 'The agent'} is asking whether to trust ${folder}, which an unattended worker cannot answer.`
  const trustOnce = `Start ${agent ?? 'the agent'} in ${folder} once and choose to trust the folder`
  if (agent === null) {
    return new WorkerStartTrustBlockedError(
      `${prompt} This terminal was reused, so Orca cannot tell which agent's trust applies.`,
      `${trustOnce}, then start the worker again.`
    )
  }
  if (diagnosis?.kind === 'written') {
    return new WorkerStartTrustBlockedError(
      `${prompt} Orca's trust write has now landed, so starting the worker again should get past this screen.`,
      `Start the worker again; if ${agent} still asks, start it in ${folder} once and choose to trust the folder.`
    )
  }
  const cause =
    diagnosis === null
      ? 'Orca could not look up this workspace to check its trust write.'
      : diagnosis.kind === 'failed'
        ? `Orca could not pre-trust it: ${diagnosis.detail.replace(/\.+$/, '')}.`
        : diagnosis.kind === 'still-waiting'
          ? `Orca's trust write is still waiting behind another ${agent} config change.`
          : diagnosis.host === 'wsl'
            ? `Orca does not pre-trust folders for ${agent} inside WSL.`
            : diagnosis.host === 'ssh'
              ? `Orca does not pre-trust folders for ${agent} on SSH hosts.`
              : `Orca does not pre-trust folders for ${agent}.`
  return new WorkerStartTrustBlockedError(
    `${prompt} ${cause}`,
    `${trustOnce}${diagnosis?.kind === 'failed' ? ' (or fix the file named above)' : ''}, then start the worker again.`
  )
}
