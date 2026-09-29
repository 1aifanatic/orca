import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { markCodexProjectTrusted } from '../agent-trust-presets'
import { awaitAgentTrustWriteWithinDeadline } from '../agent-trust-write-deadline'
import {
  isSeparateCodexLaunchHome,
  markCodexProjectTrustedInHome
} from '../codex/codex-project-trust-write'
import { markRemoteAgentWorkspaceTrusted } from '../remote-agent-trust-presets'
import { isWslPath } from '../wsl'
import { writeLocalAgentWorkspaceTrust } from './runtime-worktree-agent-startup'

// Why short: this runs inside a failing worker-start, which must report promptly; 20 s is the launch budget.
export const WORKSPACE_TRUST_DIAGNOSIS_DEADLINE_MS = 5_000

export type WorkspaceTrustDiagnosis =
  | { kind: 'not-pretrusted'; host: 'any' | 'wsl' | 'ssh' }
  | { kind: 'written' }
  | { kind: 'failed'; detail: string }
  | { kind: 'still-waiting' }

/**
 * Why (#23847): a worker stalled at the agent's trust screen re-runs that agent's own idempotent
 * trust write on the launch's host and homes, so the cause it reports is this launch's by
 * construction rather than whatever an earlier launch on the same path left behind.
 * Never throws: it only explains a failure that has already happened.
 */
export async function diagnoseAgentWorkspaceTrust(args: {
  agent: TuiAgent
  connectionId: string | null
  workspacePath: string
  /** The CODEX_HOME a launch would read now, from the side-effect-free resolver; null is real ~/.codex. */
  resolveCodexLaunchHome: () => Promise<string | null>
}): Promise<WorkspaceTrustDiagnosis> {
  try {
    const preset = TUI_AGENT_CONFIG[args.agent].preflightTrust
    if (!preset) {
      return { kind: 'not-pretrusted', host: 'any' }
    }
    const { connectionId, workspacePath } = args
    // Why: Codex launch prep skips trust for WSL, whose Codex reads the distro's own home.
    if (!connectionId && preset === 'codex' && isWslPath(workspacePath)) {
      return { kind: 'not-pretrusted', host: 'wsl' }
    }
    const write = connectionId
      ? markRemoteAgentWorkspaceTrusted({ preset, connectionId, workspacePath })
      : preset === 'codex'
        ? writeCodexTrustForLaunchHomes(workspacePath, args.resolveCodexLaunchHome)
        : writeLocalAgentWorkspaceTrust(preset, workspacePath)
    const outcome = await awaitAgentTrustWriteWithinDeadline(write, {
      preset,
      workspacePath,
      deadlineMs: WORKSPACE_TRUST_DIAGNOSIS_DEADLINE_MS
    })
    if (outcome === 'expired') {
      return { kind: 'still-waiting' }
    }
    const remote = await write
    if (remote === 'no-remote-preset') {
      return { kind: 'not-pretrusted', host: 'ssh' }
    }
    if (remote === 'no-remote-home') {
      return {
        kind: 'failed',
        detail: `Orca could not resolve the home directory on SSH connection ${connectionId}, so no trust file was written`
      }
    }
    return { kind: 'written' }
  } catch (error) {
    return { kind: 'failed', detail: describeTrustWriteFailure(error) }
  }
}

function describeTrustWriteFailure(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(describeTrustWriteFailure).join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}

/** The same homes a local Codex launch writes: ~/.codex, the shared managed home, and the launch's own home. */
async function writeCodexTrustForLaunchHomes(
  workspacePath: string,
  resolveLaunchHome: () => Promise<string | null>
): Promise<void> {
  const results = await Promise.allSettled([
    markCodexProjectTrusted(workspacePath),
    resolveLaunchHome().then((home) =>
      isSeparateCodexLaunchHome(home)
        ? markCodexProjectTrustedInHome(workspacePath, home)
        : undefined
    )
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `Orca could not mark ${workspacePath} trusted`)
  }
}
