import { homedir } from 'node:os'
import { markQoderWorkspaceTrusted } from './qoder/workspace-trust'
import {
  type AgentTrustPreset,
  markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} from './agent-trust-presets'
import {
  AGENT_TRUST_WRITE_DEADLINE_MS,
  SHORT_AGENT_TRUST_WRITE_DEADLINE_MS,
  awaitAgentTrustWriteWithinDeadline
} from './agent-trust-write-deadline'
import { markRemoteAgentWorkspaceTrusted } from './remote-agent-trust-presets'
import {
  grantClaudeWorkspaceTrust,
  resolveLocalClaudeTrustConfig
} from './claude/claude-folder-trust-file'
import type { ClaudeRuntimeAuthPreparation } from './claude-accounts/runtime-auth/runtime-auth-types'
import type { ClaudeFolderTrustSpawnRequest } from '../shared/claude-folder-trust-spawn-request'
import { parseWslUncPath } from '../shared/wsl-paths'
import { isTooBroadToPreTrust } from '../shared/home-or-filesystem-root'
import { isLocalFolderTooBroadToPreTrust } from './local-folder-trust-breadth'
import { getCachedWslHome } from './wsl-home-cache'

/** What a trust writer needs to reach the file the launched agent will read. */
export type AgentTrustLaunchContext = {
  /** The final spawn env, before the host's own process env. */
  env: Record<string, string | undefined> | undefined
  /** Managed-account auth prep for a Claude launch; names a WSL guest's config dir. */
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  wslDistro: string | null
  /** SSH connection that runs the agent; null means this machine. */
  connectionId: string | null
}

/** Spawn fields the dispatcher asks the caller to forward to the process owner. */
export type AgentTrustSpawnFields = {
  claudeFolderTrust?: ClaudeFolderTrustSpawnRequest
}

function writeLocalPreset(
  preset: Exclude<AgentTrustPreset, 'claude'>,
  workspacePath: string
): Promise<void> {
  switch (preset) {
    case 'codex':
      return markCodexProjectTrusted(workspacePath)
    case 'cursor':
      return Promise.resolve().then(() => markCursorWorkspaceTrusted(workspacePath))
    case 'copilot':
      return Promise.resolve().then(() => markCopilotFolderTrusted(workspacePath))
    case 'qoder':
      return Promise.resolve().then(() => markQoderWorkspaceTrusted(workspacePath))
    case 'antigravity':
      return Promise.resolve().then(() => markAntigravityWorkspaceTrusted(workspacePath))
  }
}

async function writeLocalClaude(workspacePath: string, context: AgentTrustLaunchContext) {
  const target = resolveLocalClaudeTrustConfig({
    workspacePath,
    env: { ...process.env, ...context.env },
    claudeAuth: context.claudeAuth,
    wslDistro: context.wslDistro
  })
  if (target) {
    await grantClaudeWorkspaceTrust(target, workspacePath)
  }
}

function isWslLaunch(workspacePath: string, context: AgentTrustLaunchContext): boolean {
  return (
    Boolean(context.wslDistro) ||
    context.claudeAuth?.runtime === 'wsl' ||
    parseWslUncPath(workspacePath) !== null
  )
}

/** Homes an agent on this machine may read trust under; SSH hosts check their own. */
function localHomePaths(workspacePath: string, context: AgentTrustLaunchContext) {
  const wslWorkspace = parseWslUncPath(workspacePath)
  return [
    homedir(),
    context.env?.HOME,
    context.env?.USERPROFILE,
    wslWorkspace ? getCachedWslHome(wslWorkspace.distro) : null
  ]
}

function startTrustWrite(
  preset: AgentTrustPreset,
  workspacePath: string,
  context: AgentTrustLaunchContext
): Promise<void> | null {
  if (context.connectionId) {
    return markRemoteAgentWorkspaceTrusted({
      preset,
      connectionId: context.connectionId,
      workspacePath
    })
  }
  // Why: the other writers target this host's home, which a WSL guest agent never reads.
  if (preset !== 'claude' && isWslLaunch(workspacePath, context)) {
    return null
  }
  if (isLocalFolderTooBroadToPreTrust(workspacePath, localHomePaths(workspacePath, context))) {
    // Why: trust on a home, a folder above one or a root would cover the home for some agents.
    return null
  }
  return preset === 'claude'
    ? writeLocalClaude(workspacePath, context)
    : writeLocalPreset(preset, workspacePath)
}

/**
 * Pre-trusts `workspacePath` for the agent Orca is about to start, on the host that runs
 * it. Never throws and never waits past the preset's deadline: a miss means the agent asks.
 */
export async function applyAgentWorkspaceTrust(
  preset: AgentTrustPreset,
  workspacePath: string,
  context: AgentTrustLaunchContext
): Promise<AgentTrustSpawnFields> {
  try {
    if (context.connectionId) {
      if (isTooBroadToPreTrust(workspacePath, [])) {
        // Why: the SSH host checks its own home; a root is too broad on any host.
        return {}
      }
      if (preset === 'claude') {
        // Why: the relay owns the remote file, its lock and the agent's final env.
        return { claudeFolderTrust: { workspacePath } }
      }
    }
    const write = startTrustWrite(preset, workspacePath, context)
    if (write) {
      await awaitAgentTrustWriteWithinDeadline(write, {
        preset,
        workspacePath,
        // Why: Codex queues behind a shared config lane, and SSH writes cross a possibly slow link.
        deadlineMs:
          preset === 'codex' || context.connectionId
            ? AGENT_TRUST_WRITE_DEADLINE_MS
            : SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
      })
    }
  } catch (error) {
    console.warn(
      `[agent-trust] ${preset} trust for ${workspacePath} failed; the agent will ask`,
      error
    )
  }
  return {}
}
