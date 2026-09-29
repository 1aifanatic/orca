import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseClaudeFolderTrustSpawnRequest } from '../shared/claude-folder-trust-spawn-request'
import {
  grantClaudeWorkspaceTrust,
  resolveClaudeGlobalConfigFile
} from '../main/claude/claude-folder-trust-file'
import {
  awaitAgentTrustWriteWithinDeadline,
  SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
} from '../main/agent-trust-write-deadline'

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
  const keyStyle = process.platform === 'win32' ? 'win32' : 'posix'
  const homeDir = (keyStyle === 'win32' ? spawnEnv.USERPROFILE : spawnEnv.HOME) || homedir()
  const configFile = resolveClaudeGlobalConfigFile({
    env: spawnEnv,
    homeDir,
    style: keyStyle,
    exists: existsSync
  })
  // Why: trust bookkeeping must never fail or stall the spawn; a miss means Claude asks.
  await awaitAgentTrustWriteWithinDeadline(
    grantClaudeWorkspaceTrust({ configFile, keyStyle }, request.workspacePath).then(() => {}),
    {
      preset: 'claude',
      workspacePath: request.workspacePath,
      deadlineMs: SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
    }
  ).catch((error: unknown) => {
    console.warn('[claude-trust] relay grant failed; Claude will ask instead', error)
  })
}
