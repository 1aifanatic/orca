import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  parseClaudeFolderTrustSpawnRequest,
  parseClaudeTrustConvergeRequests,
  readClaudeTrustConfigEnv
} from '../shared/claude-folder-trust-spawn-request'
import { resolveClaudeGlobalConfigFile } from '../main/claude/claude-folder-trust-file'
import {
  convergeClaudeWorktreeTrustOnHost,
  convergeClaudeWorktreesTrustOnHost,
  type ClaudeWorktreeTrustHostRequest
} from '../main/claude/claude-worktree-trust-host'

function relayClaudeConfigTarget(
  env: Record<string, string | undefined>
): Pick<ClaudeWorktreeTrustHostRequest, 'configFile' | 'keyStyle'> {
  const style = process.platform === 'win32' ? 'win32' : 'posix'
  const homeDir = (style === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
  return {
    configFile: resolveClaudeGlobalConfigFile({ env, homeDir, style, exists: existsSync }),
    keyStyle: style
  }
}

/**
 * Why here: this host owns the file Claude reads, so the lock, the re-read under it,
 * symlink handling and the mode all act on local disk instead of across the SSH link.
 */
export async function applyRelayClaudeFolderTrust(
  rawRequest: unknown,
  spawnEnv: Record<string, string | undefined>
): Promise<void> {
  const request = parseClaudeFolderTrustSpawnRequest(rawRequest)
  if (!request) {
    return
  }
  await convergeClaudeWorktreeTrustOnHost({ ...request, ...relayClaudeConfigTarget(spawnEnv) })
}

/** `claudeTrust.converge`: resolve the same config file a spawn with the desktop's Claude env would. */
export async function applyRelayClaudeTrustConverge(
  params: Record<string, unknown>
): Promise<void> {
  const target = relayClaudeConfigTarget({
    ...process.env,
    ...readClaudeTrustConfigEnv(params.env)
  })
  await convergeClaudeWorktreesTrustOnHost(
    parseClaudeTrustConvergeRequests(params.requests).map((request) => ({ ...request, ...target }))
  )
}
