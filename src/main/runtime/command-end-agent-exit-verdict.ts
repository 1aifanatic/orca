import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'

type CommandEndAgentExitDeps = {
  /** A fresh foreground read on the PTY's execution host; throws or answers null when it cannot. */
  readForegroundProcess(): Promise<string | null>
  /** The hook presence check: a Claude row's own pid and start time; null when no hook identified it. */
  checkHookAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null>
}

/**
 * Whether the agent behind a command end (OSC 133;D) really exited. A full-screen agent's nested
 * shells leak their own 133;D onto the pane, so the mark alone never proves it. The foreground
 * answers first, as the renderer's command-finished confirmation does: an agent there is `live`,
 * a shell there is `exited`. Anything else (no answer, a wrapper, another command) falls back to
 * the hook presence check, and without proof either way the verdict is `unverifiable`.
 */
export async function verifyCommandEndAgentExit(
  paneKeys: Iterable<string>,
  deps: CommandEndAgentExitDeps
): Promise<AgentProcessVerdict> {
  let foreground: string | null = null
  try {
    foreground = await deps.readForegroundProcess()
  } catch {
    // Loss of contact with the execution host is never evidence the agent exited.
  }
  if (foreground && recognizeAgentProcess(foreground)) {
    return 'live'
  }
  if (foreground && isShellProcess(foreground)) {
    return 'exited'
  }
  const verdicts = await Promise.all(
    Array.from(paneKeys, (paneKey) => deps.checkHookAgentPresence(paneKey).catch(() => null))
  )
  if (verdicts.includes('live')) {
    return 'live'
  }
  return verdicts.includes('exited') && !verdicts.includes('unverifiable')
    ? 'exited'
    : 'unverifiable'
}
