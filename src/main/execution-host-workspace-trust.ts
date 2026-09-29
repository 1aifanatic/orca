import { realpathSync } from 'node:fs'
import { markQoderWorkspaceTrusted } from './qoder/workspace-trust'
import {
  type AgentTrustPreset,
  markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted,
  resolveCodexProjectTrustRoot
} from './agent-trust-presets'
import { awaitAgentTrustWriteWithinDeadline } from './agent-trust-write-deadline'
import {
  type ClaudeTrustConfigTarget,
  grantClaudeWorkspaceTrust
} from './claude/claude-folder-trust-file'
import { isTooBroadToPreTrust } from '../shared/home-or-filesystem-root'

/**
 * What the host that runs the agent knows about where that agent reads trust. Relay-safe:
 * main describes this machine or a WSL guest, the SSH relay describes its own host.
 */
export type WorkspaceTrustHost = {
  /** Homes the agent may read trust under; when none is known, nothing is written. */
  homes: readonly (string | null | undefined)[]
  /** The config Claude reads on this host, or null when this host cannot tell. */
  claudeConfig: () => ClaudeTrustConfigTarget | null
  /** Every config.toml the launched Codex may read, in the hook installer's lock order. */
  codexConfigFiles: () => readonly string[]
  deadlineMs: number
}

function withResolvedForm(path: string): string[] {
  try {
    return [path, realpathSync.native(path)]
  } catch {
    return [path]
  }
}

/** The path the preset's writer stores: Codex trusts a linked worktree's main checkout. */
function storedTrustPath(preset: AgentTrustPreset, workspacePath: string): string {
  return preset === 'codex' ? resolveCodexProjectTrustRoot(workspacePath) : workspacePath
}

/**
 * Whether trust stored for `storedPath` would cover a home: it is a root, a home or a folder
 * above one. Both sides are compared given and resolved, since the writers store the realpath.
 */
function wouldTrustAHome(storedPath: string, homes: readonly string[]): boolean {
  const homeForms = homes.flatMap(withResolvedForm)
  return withResolvedForm(storedPath).some((form) => isTooBroadToPreTrust(form, homeForms))
}

async function writePreset(
  preset: AgentTrustPreset,
  storedPath: string,
  host: WorkspaceTrustHost
): Promise<void> {
  switch (preset) {
    case 'claude': {
      const target = host.claudeConfig()
      if (target) {
        await grantClaudeWorkspaceTrust(target, storedPath)
      }
      return
    }
    case 'codex':
      return markCodexProjectTrusted(storedPath, host.codexConfigFiles())
    case 'cursor':
      return markCursorWorkspaceTrusted(storedPath)
    case 'copilot':
      return markCopilotFolderTrusted(storedPath)
    case 'qoder':
      return markQoderWorkspaceTrusted(storedPath)
    case 'antigravity':
      return markAntigravityWorkspaceTrusted(storedPath)
  }
}

/**
 * The one place a preset's trust is written, on the host that runs the agent. Refuses when the
 * path the writer would store covers a home, and never throws or waits past the host's
 * deadline: any failure or miss means the agent asks.
 */
export async function applyWorkspaceTrustOnThisHost(
  preset: AgentTrustPreset,
  workspacePath: string,
  describeHost: () => WorkspaceTrustHost
): Promise<void> {
  try {
    const host = describeHost()
    const homes = host.homes.filter((home): home is string => Boolean(home))
    const storedPath = storedTrustPath(preset, workspacePath)
    // Why: some agents let trust on a folder cover everything inside it.
    if (homes.length === 0 || wouldTrustAHome(storedPath, homes)) {
      return
    }
    await awaitAgentTrustWriteWithinDeadline(writePreset(preset, storedPath, host), {
      preset,
      workspacePath,
      deadlineMs: host.deadlineMs
    })
  } catch (error) {
    console.warn(
      `[agent-trust] ${preset} trust for ${workspacePath} failed; the agent will ask`,
      error
    )
  }
}
