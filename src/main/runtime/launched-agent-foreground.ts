import {
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../../shared/process-table-snapshot'
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

function isLaunchedAgent(processName: string, agent: TuiAgent): boolean {
  return (
    recognizeAgentProcess(processName)?.agent === agent ||
    isExpectedAgentProcess(processName, TUI_AGENT_CONFIG[agent].expectedProcess)
  )
}

/**
 * First the host's process-group observation, which only ever proves the agent: the launched agent
 * among the members of the terminal's foreground group finds it behind a wrapper that did not
 * `exec` it (a script, or the `/bin/sh` a tcsh or nu launch line runs), whose own name leads the
 * group. It counts only from a capture begun after this read was asked for, less the window a
 * shared capture is reused across, and never by how long `ps` took on a loaded host. It never
 * proves a shell: a macOS pane's shell runs under `login`, so the group's root is not the shell,
 * and a capture that ran out of time is no answer.
 *
 * Otherwise one fresh read of the terminal's foreground process: on a local POSIX host the scan
 * behind `confirmForegroundProcess`, and on an SSH host the relay's name, which it reads from the
 * terminal when asked. Never the cached name a tab icon uses: it can still name a process that
 * already exited.
 *
 * Windows has no foreground process group, and its scan names the pane's shell for an agent it
 * cannot recognize, while Git Bash and WSL keep other processes in the shell's job, so nothing
 * there proves the agent. A Windows host can still prove its shell alone (`confirmShellForeground`).
 */
export async function readLaunchedAgentForeground(
  controller: Pick<
    RuntimePtyController,
    | 'getForegroundProcess'
    | 'confirmForegroundProcess'
    | 'confirmShellForeground'
    | 'inspectProcess'
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
    const askedAt = Date.now()
    const evidence = (await controller.inspectProcess?.(ptyId))?.foregroundProcessEvidence
    if (
      evidence?.verdict === 'live' &&
      evidence.fence.platform === 'posix' &&
      Date.now() - evidence.capturedAgeMs >= askedAt - PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS &&
      evidence.processName &&
      isLaunchedAgent(evidence.processName, agent)
    ) {
      return 'agent'
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
