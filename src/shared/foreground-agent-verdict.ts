import { recognizeAgentProcess } from './agent-process-recognition'
import { isShellProcess } from './shell-process-detection'

/** A process name can disprove agent ownership only when it positively names a shell. */
export function foregroundAgentVerdict(
  processName: string | null | undefined
): 'live' | 'unverifiable' | 'exited' {
  if (!processName?.trim()) {
    return 'unverifiable'
  }
  if (recognizeAgentProcess(processName)) {
    return 'live'
  }
  return isShellProcess(processName) ? 'exited' : 'unverifiable'
}
