import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type ShellCommandPty = Pick<RuntimePtyWorktreeRecord, 'incarnationId' | 'runningShellCommand'>

type AgentHoldPty = ShellCommandPty &
  Pick<
    RuntimePtyWorktreeRecord,
    | 'launchAgent'
    | 'foregroundAgent'
    | 'foregroundAgentIncarnationId'
    | 'lastAgentStatus'
    | 'lastAgentStatusObservedLive'
  >

/** OSC 133;C: the next 133;D ends a command this incarnation started. */
export function noteShellCommandStarted(pty: ShellCommandPty): void {
  pty.runningShellCommand = { incarnationId: pty.incarnationId }
}

/**
 * OSC 133;D: whether it can end an agent this PTY held, meaning one seen live (by a read or its
 * own title) or one launched by the command this D closes. Consumes the running command.
 */
export function takeShellCommandFinishedAgentHold(pty: AgentHoldPty): boolean {
  // Why: a user shell integration can print 133;D at the first prompt, before the launch runs.
  const endsLaunchedCommand =
    Boolean(pty.launchAgent) &&
    pty.runningShellCommand !== undefined &&
    pty.runningShellCommand.incarnationId === pty.incarnationId
  pty.runningShellCommand = undefined
  return (
    endsLaunchedCommand ||
    (Boolean(pty.foregroundAgent) && pty.foregroundAgentIncarnationId === pty.incarnationId) ||
    (Boolean(pty.lastAgentStatus) && pty.lastAgentStatusObservedLive)
  )
}
