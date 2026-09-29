import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  parseClaudeFolderTrustSpawnRequest,
  readClaudeTrustConfigEnv
} from '../shared/claude-folder-trust-spawn-request'
import { resolveClaudeGlobalConfigFile } from '../main/claude/claude-folder-trust-file'
import { convergeClaudeWorktreeTrustOnHost } from '../main/claude/claude-worktree-trust-host'

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
  const style = process.platform === 'win32' ? 'win32' : 'posix'
  const homeDir = (style === 'win32' ? spawnEnv.USERPROFILE : spawnEnv.HOME) || homedir()
  await convergeClaudeWorktreeTrustOnHost({
    ...request,
    configFile: resolveClaudeGlobalConfigFile({
      env: spawnEnv,
      homeDir,
      style,
      exists: existsSync
    }),
    keyStyle: style
  })
}

/** `claudeTrust.converge`: resolve the same config file a spawn with the desktop's Claude env would. */
export async function applyRelayClaudeTrustConverge(
  params: Record<string, unknown>
): Promise<void> {
  await applyRelayClaudeFolderTrust(params.request, {
    ...process.env,
    ...readClaudeTrustConfigEnv(params.env)
  })
}
