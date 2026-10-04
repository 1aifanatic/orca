import { userInfo } from 'node:os'
import { win32 as pathWin32 } from 'node:path'

/**
 * Whether Codex run without CODEX_HOME resolves the same ~/.codex that
 * getSystemCodexHomePath() names. Node's homedir() honours USERPROFILE (Windows)
 * and returns an empty HOME as-is; Codex reads the profile known folder on
 * Windows and treats an empty HOME as unset. Where they differ, Orca's
 * real-home writes and a default-home Codex would target different homes.
 */
export function isSystemCodexHomeCodexDefault(): boolean {
  if (process.platform !== 'win32') {
    return process.env.HOME !== ''
  }
  const override = process.env.USERPROFILE
  if (!override) {
    return true
  }
  try {
    return windowsPathKey(override) === windowsPathKey(userInfo().homedir)
  } catch {
    // Why: an unreadable profile cannot prove the homes agree; the managed lane still works.
    return false
  }
}

function windowsPathKey(path: string): string {
  return pathWin32.resolve(path).toLowerCase()
}
