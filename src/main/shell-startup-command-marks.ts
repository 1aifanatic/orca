/**
 * Whether the shell integration Orca launches a pane with marks that pane's startup command with
 * OSC 133 (C when the command takes the terminal, D / A when the shell takes it back).
 *
 * Decided from what Orca launched, never from the pane's output: output from a daemon-hosted shell
 * reaches the runtime on its own batched stream, so "has a mark arrived yet" is a race, while
 * "will one come" is fixed the moment Orca picks the wrapper. A launch-readiness wait can prove the
 * agent owns the PTY only where the answer is true.
 */
import { win32 as pathWin32 } from 'node:path'
import type { ShellStartupFeature } from './shell-startup-features'
import type { ZshStartupHookSpec } from './zsh-startup-wrapper-builder'

export type ShellStartupCommandMarksInput = {
  shellPath: string
  /** The features Orca's wrapper was launched with; null when the shell runs unwrapped. */
  wrapperFeatures: readonly ShellStartupFeature[] | null
  /** The zsh wrapper this host writes. */
  zshWrapper: Pick<ZshStartupHookSpec, 'osc133CommandMarkers'>
  /** The wrapper runs the startup command from its own prompt hook instead of reading it as input. */
  startupCommandRunByPromptHook: boolean
}

export function shellMarksStartupCommand(input: ShellStartupCommandMarksInput): boolean {
  if (input.wrapperFeatures === null) {
    return false
  }
  const shellName = pathWin32.basename(input.shellPath).toLowerCase()
  if (shellName === 'zsh') {
    // Why either delivery: zsh runs a prompt-hook command through accept-line, so preexec marks it.
    return input.zshWrapper.osc133CommandMarkers && input.wrapperFeatures.includes('markers')
  }
  if (shellName === 'bash') {
    // Why: a command run from PROMPT_COMMAND goes unmarked on bash before 5.1 (macOS /bin/bash is
    // 3.2), and the version is unknown at launch; typed input is marked on every version.
    return !input.startupCommandRunByPromptHook
  }
  // fish: Orca's init command writes only its ready marker. PowerShell and cmd are unverified for a
  // startup command, and Windows keeps the base startup delivery.
  return false
}
