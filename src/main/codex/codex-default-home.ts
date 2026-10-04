import { userInfo } from 'node:os'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'

/**
 * Whether every Codex Orca starts without CODEX_HOME resolves the same ~/.codex
 * that getSystemCodexHomePath() names. Node's homedir() honours USERPROFILE
 * (Windows) and returns an empty HOME as-is; Codex reads the profile known folder
 * on Windows and treats an empty HOME as unset. Where they differ, Orca's
 * real-home writes and a default-home Codex would target different homes.
 */
export function isSystemCodexHomeCodexDefault(): boolean {
  if (process.platform === 'win32') {
    const override = process.env.USERPROFILE
    return (
      !override || accountHomeMatches(override, (path) => pathWin32.resolve(path).toLowerCase())
    )
  }
  const home = process.env.HOME
  if (home === '') {
    return false
  }
  // Why: macOS panes start through login(1), which resets HOME to the account's home.
  return (
    process.platform !== 'darwin' ||
    home === undefined ||
    accountHomeMatches(home, (path) => pathPosix.resolve(path))
  )
}

function accountHomeMatches(home: string, toKey: (path: string) => string): boolean {
  try {
    return toKey(home) === toKey(userInfo().homedir)
  } catch {
    // Why: an unreadable account home cannot prove the homes agree; the managed lane still works.
    return false
  }
}
