import {
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

/** A login shell is reported as `-zsh`. */
function isLaunchShell(processName: string): boolean {
  return isShellProcess(processName.replace(/^-/, ''))
}

/**
 * Whether a shell, rather than the agent a launch started, is proven to be in the terminal's
 * foreground: the launch line has not run yet, or the agent exited. A read that fails or cannot
 * tell proves nothing, so it never delays a launch.
 *
 * On macOS and Linux a fresh foreground read that names a shell proves it. The host's
 * shell-foreground check cannot: the terminal daemon answers it from its recovery state, which a
 * plain exit leaves unset. Windows takes only that check, since its scan names the pane's shell for
 * any agent it cannot recognize (an npm agent running as `node.exe`), so a daemon pane there proves
 * nothing.
 *
 * Why no check for a non-shell name other than the agent's own: for its first 5 s the daemon's
 * cached read names the launch agent whenever a shell is in front (measured on a zsh pane: cached
 * `copilot`, scan `zsh`), so any other non-shell name it gives is the process itself. macOS
 * reports the native Claude by its version (`2.1.258`), and a runtime such as node can front an
 * agent.
 */
export async function isShellInFrontOfLaunchedAgent(
  controller: Pick<
    RuntimePtyController,
    'getForegroundProcess' | 'confirmForegroundProcess' | 'confirmShellForeground'
  > | null,
  host: { remote: boolean; windows: boolean },
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
    // Why the cached name for SSH: the relay reads its foreground live, with no startup bootstrap
    // to see past, and offers neither a scan nor a shell-foreground check. A Windows relay names the
    // pane's shell for an agent it cannot recognize, so there the name proves nothing.
    if (host.remote) {
      return !host.windows && isShellName(cached, agent)
    }
    if (host.windows) {
      return (await controller.confirmShellForeground?.(ptyId)) ?? false
    }
    const foreground = controller.confirmForegroundProcess
      ? await controller.confirmForegroundProcess(ptyId)
      : cached
    return isShellName(foreground, agent)
  } catch {
    return false
  }
}

function isShellName(processName: string | null, agent: TuiAgent): boolean {
  return (
    !!processName &&
    isLaunchShell(processName) &&
    !isExpectedAgentProcess(processName, TUI_AGENT_CONFIG[agent].expectedProcess)
  )
}
