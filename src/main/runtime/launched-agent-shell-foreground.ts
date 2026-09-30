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
 * foreground: the launch line has not run yet, or the agent exited. Only a read that names a shell
 * proves one; a read that fails or names any other process does not, so it never delays a launch.
 * macOS reports the native Claude by its version (`2.1.258`), and a runtime such as node can front
 * an agent.
 *
 * Why a scan only for the agent's own name or a shell: for its first 5 s the daemon's cached read
 * names the launch agent whenever a shell is in front (measured on a zsh pane: cached `copilot`,
 * scan `zsh`), so any other non-shell name it gives is the process itself.
 */
export async function isShellInFrontOfLaunchedAgent(
  controller: Pick<
    RuntimePtyController,
    'getForegroundProcess' | 'confirmForegroundProcess'
  > | null,
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
    // Why not for SSH: the relay reads its foreground live, with no startup bootstrap to see past,
    // and has no scan; the controller answers null for one.
    const foreground =
      controller.confirmForegroundProcess && !pty?.connectionId
        ? await controller.confirmForegroundProcess(ptyId)
        : cached
    return (
      !!foreground &&
      isLaunchShell(foreground) &&
      !isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess)
    )
  } catch {
    return false
  }
}
