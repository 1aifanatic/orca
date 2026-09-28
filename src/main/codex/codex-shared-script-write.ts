import { readFileSync } from 'node:fs'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { withRealHomeWriteLock } from './codex-hook-trust-queue'

export function sharedCodexScriptMatches(scriptPath: string, script: string): boolean {
  try {
    return readFileSync(scriptPath, 'utf-8') === script
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
