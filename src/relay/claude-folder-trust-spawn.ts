import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseClaudeFolderTrustSpawnRequest } from '../shared/claude-folder-trust-spawn-request'
import { resolveClaudeGlobalConfigFile } from '../main/claude/claude-folder-trust-file'
import { SHORT_AGENT_TRUST_WRITE_DEADLINE_MS } from '../main/agent-trust-write-deadline'
import { applyWorkspaceTrustOnThisHost } from '../main/execution-host-workspace-trust'

/**
 * Why here: this host owns the file Claude reads, so the lock, the re-read under it,
 * symlink handling and the mode all act on local disk instead of across the SSH link.
 */
export async function applyRelayClaudeFolderTrust(
  rawRequest: unknown,
  spawnEnv: Record<string, string | undefined>,
  launch: { wslShell: boolean }
): Promise<void> {
  const request = parseClaudeFolderTrustSpawnRequest(rawRequest)
  // Why: a Claude inside a WSL guest reads the guest's config, not this Windows host's.
  if (!request || launch.wslShell) {
    return
  }
  await applyWorkspaceTrustOnThisHost('claude', request.workspacePath, () => {
    const keyStyle = process.platform === 'win32' ? 'win32' : 'posix'
    const homeDir = (keyStyle === 'win32' ? spawnEnv.USERPROFILE : spawnEnv.HOME) || homedir()
    return {
      homes: [homeDir, homedir()],
      claudeConfig: () => ({
        configFile: resolveClaudeGlobalConfigFile({
          env: spawnEnv,
          homeDir,
          style: keyStyle,
          exists: existsSync
        }),
        keyStyle
      }),
      codexConfigFiles: () => [],
      // Why: this write is on the relay's own disk, so it gets the local budget.
      deadlineMs: SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
    }
  })
}
