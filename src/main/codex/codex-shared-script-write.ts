import { readFileSync, statSync } from 'node:fs'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { withRealHomeWriteLock } from './codex-hook-trust-queue'

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

/** Writes the shared ~/.orca/agent-hooks script under the real-home lock, only when it differs. */
export async function writeSharedCodexScriptIfChanged(
  scriptPath: string,
  script: string
): Promise<void> {
  if (sharedCodexScriptMatches(scriptPath, script)) {
    return
  }
  // Why no recheck here: writeManagedScript re-reads and skips identical bytes.
  await withRealHomeWriteLock(async () => writeManagedScript(scriptPath, script))
}
