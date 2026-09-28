import { readFileSync, statSync } from 'node:fs'
import { writeManagedScript } from '../agent-hooks/installer-utils'

export function sharedCodexScriptMatches(scriptPath: string, script: string): boolean {
  try {
    // Why the mode: the POSIX hook guard skips a non-executable script, and only a write restores it.
    return (
      readFileSync(scriptPath, 'utf-8') === script &&
      (process.platform === 'win32' || (statSync(scriptPath).mode & 0o777) === 0o755)
    )
  } catch {
    return false
  }
}

/**
 * Writes the shared ~/.orca/agent-hooks script only when it differs. Why no
 * real-home lock: the write is atomic and every build writes the same bytes, so
 * waiting behind another instance's trust session could only fail the install.
 */
export function writeSharedCodexScriptIfChanged(scriptPath: string, script: string): void {
  if (sharedCodexScriptMatches(scriptPath, script)) {
    return
  }
  writeManagedScript(scriptPath, script)
}
