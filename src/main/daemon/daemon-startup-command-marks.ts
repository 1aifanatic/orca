import { shellMarksStartupCommand } from '../shell-startup-command-marks'
import { selectShellStartupFeatures } from '../shell-startup-features'
import { getDaemonZshWrapperSpec } from './daemon-zsh-shell-ready-wrapper-spec'

/**
 * Whether the shell the daemon launches for a startup command marks it with OSC 133. Answered in
 * main from the same shell and feature selection the daemon's launch plan makes, so no wire field:
 * the daemon types the command at the shell's first prompt, never from a prompt hook.
 */
export function daemonShellMarksStartupCommand(
  shellPath: string,
  env: Record<string, string>
): boolean {
  return shellMarksStartupCommand({
    shellPath,
    wrapperFeatures: selectShellStartupFeatures({
      shellPath,
      env,
      hasStartupCommand: true,
      waitsForShellReady: true,
      emitsStartupIdentity: true
    }),
    zshWrapper: getDaemonZshWrapperSpec(),
    startupCommandRunByPromptHook: false
  })
}
