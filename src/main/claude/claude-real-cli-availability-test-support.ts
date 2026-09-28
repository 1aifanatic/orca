// Whether a real, signed-in Claude CLI is present — the gate every real-CLI
// suite skips on. Probed once per test process.

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import { resolveClaudeCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'

export const realClaudeCommand = resolveClaudeCommand()

const versionLaunch = getSpawnArgsForWindows(realClaudeCommand, ['--version'])
export const realClaudeAvailable =
  spawnSync(versionLaunch.spawnCmd, versionLaunch.spawnArgs, {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000
  }).status === 0

const authStatusLaunch = getSpawnArgsForWindows(realClaudeCommand, ['auth', 'status', '--json'])
/** The CLI's own account report — the only source of truth for where it writes that
 *  is not derived from Orca's own path expressions. */
export const realClaudeAuthStatus = (() => {
  if (!realClaudeAvailable) {
    return null
  }
  const result = spawnSync(authStatusLaunch.spawnCmd, authStatusLaunch.spawnArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000
  })
  if (result.status !== 0) {
    return null
  }
  try {
    return JSON.parse(result.stdout) as { loggedIn?: boolean; projectsDirectory?: string }
  } catch {
    return null
  }
})()

export const realClaudeAuthenticated = realClaudeAuthStatus?.loggedIn === true

/** The config dir and env auth the availability probe above saw, for a real-CLI launch.
 *  The connection strips an inherited CLAUDE_CONFIG_DIR and inherited auth vars, so
 *  without these the child silently runs against ~/.claude whatever the probe checked. */
export function realClaudeLaunchHome(): { claudeConfigDir: string; env: Record<string, string> } {
  const env: Record<string, string> = {}
  for (const key of CLAUDE_AUTH_ENV_VARS) {
    const value = process.env[key]
    if (value) {
      env[key] = value
    }
  }
  return {
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'),
    env
  }
}
