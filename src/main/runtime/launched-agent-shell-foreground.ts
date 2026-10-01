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
 * Whether the pane's own shell, rather than the agent a launch started, is proven to be in the
 * terminal's foreground: the launch line has not run yet, or the agent exited. A read that fails or
 * cannot tell proves nothing, so it never delays a launch.
 *
 * On macOS and Linux identity decides first: the host's process inspection reports the terminal's
 * foreground process group, and the pane's shell can be in front only when that group is the
 * shell's own. A wrapper script's bash, or a conda hook, runs as its own job, so it is not the
 * pane's shell even though it is named like one. A fresh read must then also name a shell.
 *
 * Windows has no foreground process group, and its scan names the pane's shell for any agent it
 * cannot recognize (an npm agent running as `node.exe`), so it takes only the host's
 * shell-foreground check (the shell alone in the pane's job). A daemon pane answers that from its
 * recovery state, which a plain exit leaves unset, and an SSH pane has none, so there it proves
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
    | 'getForegroundProcess'
    | 'inspectProcess'
    | 'confirmForegroundProcess'
    | 'confirmShellForeground'
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
    if (host.windows) {
      // An SSH pane has no such check, so on a Windows relay nothing proves a shell.
      return (await controller.confirmShellForeground?.(ptyId)) ?? false
    }
    const evidence = (await controller.inspectProcess?.(ptyId))?.foregroundProcessEvidence
    if (
      evidence &&
      !(
        evidence.verdict === 'live' &&
        evidence.fence.platform === 'posix' &&
        evidence.fence.foregroundPgid === evidence.fence.shellPid
      )
    ) {
      return false
    }
    // Why the name too: a shell without job control runs its commands in its own group.
    // A host that predates the evidence (an older daemon or relay, or a pane outside the daemon)
    // has only the name, which reads a wrapper script's bash as the shell. A relay's cached name is
    // read live, and it has no scan.
    const foreground =
      !host.remote && controller.confirmForegroundProcess
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
