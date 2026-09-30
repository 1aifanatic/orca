import {
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/** A login shell is reported as `-zsh`. */
function isLaunchShell(processName: string): boolean {
  return isShellProcess(processName.replace(/^-/, ''))
}

/**
 * Whether a shell, rather than the agent a launch started, is proven to be in the terminal's
 * foreground: the launch line has not run yet, or the agent exited. A read that fails or cannot
 * tell proves nothing, so it never delays a launch.
 *
 * Locally the proof is the host's own shell-foreground check (the spawned shell holds the
 * foreground: `ps` on POSIX, job membership on Windows), not a process name: Windows names the
 * shell for any agent it cannot recognize, such as an npm agent running as `node.exe`.
 *
 * Why no check for a non-shell name other than the agent's own: for its first 5 s the daemon's
 * cached read names the launch agent whenever a shell is in front (measured on a zsh pane: cached
 * `copilot`, scan `zsh`), so any other non-shell name it gives is the process itself. macOS
 * reports the native Claude by its version (`2.1.258`), and a runtime such as node can front an
 * agent.
 */
export async function isShellInFrontOfLaunchedAgent(
  controller: Pick<RuntimePtyController, 'getForegroundProcess' | 'confirmShellForeground'> | null,
  pty: Pick<RuntimePtyWorktreeRecord, 'connectionId'> | undefined,
  ptyId: string,
  agent: TuiAgent
): Promise<boolean> {
  if (!controller) {
    return false
  }
  try {
    const cached = await controller.getForegroundProcess(ptyId)
    if (cached && !isLaunchShell(cached) && recognizeAgentProcess(cached)?.agent !== agent) {
      return false
    }
    // Why the name for SSH: the relay reads its foreground live, with no startup bootstrap to see
    // past, and offers no shell-foreground proof; the controller answers false for one.
    if (pty?.connectionId) {
      return (
        !!cached &&
        isLaunchShell(cached) &&
        !isExpectedAgentProcess(cached, TUI_AGENT_CONFIG[agent].expectedProcess)
      )
    }
    return (await controller.confirmShellForeground?.(ptyId)) ?? false
  } catch {
    return false
  }
}
