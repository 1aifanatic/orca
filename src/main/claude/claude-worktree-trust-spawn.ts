import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveSetupAgentSequenceLaunchCommand } from '../../shared/setup-agent-sequencing'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { ClaudeFolderTrustSpawnRequest } from '../../shared/claude-folder-trust-spawn-request'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'
import { isClaudeLaunchCommand } from '../ipc/pty/host-env/fresh-spawn-routing'
import { resolveClaudeGlobalConfigFile } from './claude-folder-trust-file'
import {
  resolveClaudeWorktreeTrustTarget,
  type ClaudeWorktreeTrustTarget
} from './claude-worktree-trust-eligibility'
import {
  convergeClaudeWorktreeTrustOnHost,
  type ClaudeWorktreeTrustHostRequest
} from './claude-worktree-trust-host'

type TrustStore = Parameters<typeof resolveClaudeWorktreeTrustTarget>[0]

/**
 * Plain Claude launches only. `launchAgent` survives setup sequencing, which rewrites
 * the command; Agent Teams leaders converge later with their own final env.
 */
export function isClaudeTrustLaunch(args: {
  launchAgent: unknown
  command: string | undefined
  env: Record<string, string | undefined> | undefined
}): boolean {
  if (args.launchAgent === 'claude') {
    return true
  }
  if (args.launchAgent !== undefined) {
    return false
  }
  return isClaudeLaunchCommand(resolveSetupAgentSequenceLaunchCommand(args.env ?? {}, args.command))
}

function hostHomeDir(env: Record<string, string | undefined>): string {
  return (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
}

/** The config file a local (or WSL-guest) Claude will read, or null when Orca cannot tell. */
export function resolveLocalClaudeTrustRequest(
  target: ClaudeWorktreeTrustTarget,
  env: Record<string, string | undefined>,
  claudeAuth: ClaudeRuntimeAuthPreparation | null,
  wslDistro: string | null
): ClaudeWorktreeTrustHostRequest | null {
  const base = {
    worktreeRoot: target.worktreeRoot,
    mainCheckoutPath: target.mainCheckoutPath,
    trusted: target.trusted
  }
  if (claudeAuth?.runtime === 'wsl' || wslDistro) {
    // Why: a WSL guest reads its own config, reachable only through the auth prep's UNC dir.
    if (claudeAuth?.runtime !== 'wsl' || !parseWslUncPath(target.worktreeRoot)) {
      return null
    }
    const configDir = claudeAuth.configDir
    const legacyFile = join(configDir, '.config.json')
    const configFile = existsSync(legacyFile)
      ? legacyFile
      : claudeAuth.envPatch.CLAUDE_CONFIG_DIR
        ? join(configDir, '.claude.json')
        : join(dirname(configDir), '.claude.json')
    return {
      ...base,
      configFile,
      keyStyle: 'posix',
      toClaudePath: (hostPath) => parseWslUncPath(hostPath)?.linuxPath ?? null
    }
  }
  const style = process.platform === 'win32' ? 'win32' : 'posix'
  return {
    ...base,
    configFile: resolveClaudeGlobalConfigFile({
      env,
      homeDir: hostHomeDir(env),
      style,
      exists: existsSync
    }),
    keyStyle: style
  }
}

/** Converges trust for a local or WSL Claude launch just before the PTY spawns. */
export async function convergeClaudeWorktreeTrustForLocalSpawn(args: {
  store: TrustStore | undefined
  worktreeId: string | undefined
  /** The launch env as the PTY will receive it, before the host's own process env. */
  launchEnv: Record<string, string | undefined> | undefined
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  wslDistro: string | null
}): Promise<void> {
  if (!args.store) {
    return
  }
  const target = resolveClaudeWorktreeTrustTarget(args.store, args.worktreeId)
  // Why: an SSH worktree's Claude reads the remote host's file, which only the relay may write.
  if (!target || target.connectionId) {
    return
  }
  const request = resolveLocalClaudeTrustRequest(
    target,
    { ...process.env, ...args.launchEnv },
    args.claudeAuth,
    args.wslDistro
  )
  if (request) {
    await convergeClaudeWorktreeTrustOnHost(request)
  }
}

/** SSH launches: the relay owns the remote file, so main only sends the desired state. */
export function resolveClaudeFolderTrustSpawnRequest(
  store: TrustStore | undefined,
  worktreeId: string | undefined
): ClaudeFolderTrustSpawnRequest | undefined {
  const target = store ? resolveClaudeWorktreeTrustTarget(store, worktreeId) : null
  return target
    ? {
        worktreeRoot: target.worktreeRoot,
        mainCheckoutPath: target.mainCheckoutPath,
        trusted: target.trusted
      }
    : undefined
}

/**
 * One call site per spawn path. Best-effort: bookkeeping failures never block the
 * launch; Claude simply shows its own prompt.
 */
export async function applyClaudeWorktreeTrustToSpawn(args: {
  store: TrustStore | undefined
  connectionId: string | null | undefined
  worktreeId: string | undefined
  launchAgent: unknown
  command: string | undefined
  env: Record<string, string | undefined> | undefined
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  wslDistro: string | null
  isFreshLaunch: boolean
  spawnOptions: { claudeFolderTrust?: ClaudeFolderTrustSpawnRequest }
}): Promise<void> {
  if (!args.isFreshLaunch || !isClaudeTrustLaunch(args)) {
    return
  }
  try {
    if (args.connectionId) {
      const request = resolveClaudeFolderTrustSpawnRequest(args.store, args.worktreeId)
      if (request) {
        args.spawnOptions.claudeFolderTrust = request
      }
      return
    }
    await convergeClaudeWorktreeTrustForLocalSpawn({
      store: args.store,
      worktreeId: args.worktreeId,
      launchEnv: args.env,
      claudeAuth: args.claudeAuth,
      wslDistro: args.wslDistro
    })
  } catch (error) {
    console.warn('[claude-trust] skipped for this launch; Claude will ask instead', error)
  }
}
