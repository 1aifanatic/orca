import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

/**
 * What holds a launched agent's terminal: the agent (anything but the pane's shell), the shell
 * (the launch line has not run yet, or the agent exited), or `unknown` when the host cannot tell.
 * Only `agent` lets a launch write its prompt; only `shell` drops a ready signal.
 */
export type LaunchedAgentForeground = 'agent' | 'shell' | 'unknown'

/** A login shell is reported as `-zsh`. */
function isLaunchShell(processName: string): boolean {
  return isShellProcess(processName.replace(/^-/, ''))
}

/**
 * One fresh read of the terminal's foreground process: on a local POSIX host the scan behind
 * `confirmForegroundProcess`, and on an SSH host the relay's name, which it reads from the terminal
 * when asked. Never the cached name a tab icon uses: it can still name a process that already
 * exited. Not the process-group fence either: a macOS pane runs its shell under `login`, so the
 * fence's root is never the shell's group.
 *
 * Windows has no foreground process group, and its scan names the pane's shell for an agent it
 * cannot recognize, while Git Bash and WSL keep other processes in the shell's job, so nothing
 * there proves the agent. A Windows host can still prove its shell alone (`confirmShellForeground`).
 */
export async function readLaunchedAgentForeground(
  controller: Pick<
    RuntimePtyController,
    'getForegroundProcess' | 'confirmForegroundProcess' | 'confirmShellForeground'
  > | null,
  host: { remote: boolean; windows: boolean },
  ptyId: string,
  agent: TuiAgent
): Promise<LaunchedAgentForeground> {
  if (!controller) {
    return 'unknown'
  }
  try {
    if (host.windows) {
      // An SSH pane has no such check, so on a Windows relay nothing proves a shell.
      return (await controller.confirmShellForeground?.(ptyId)) ? 'shell' : 'unknown'
    }
    const foreground = host.remote
      ? await controller.getForegroundProcess(ptyId)
      : ((await controller.confirmForegroundProcess?.(ptyId)) ?? null)
    if (!foreground) {
      return 'unknown'
    }
    return isLaunchShell(foreground) &&
      !isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess)
      ? 'shell'
      : 'agent'
  } catch {
    return 'unknown'
  }
}
