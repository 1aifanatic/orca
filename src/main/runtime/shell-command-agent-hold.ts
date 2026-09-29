import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type ShellCommandPty = Pick<RuntimePtyWorktreeRecord, 'incarnationId' | 'shellCommandMarks'>

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
  pty.shellCommandMarks = { incarnationId: pty.incarnationId, commandRunning: true }
}

/** Whether this incarnation's shell has printed any OSC 133 mark, so its own 133;D can end an agent. */
export function ptyMarksShellCommands(pty: ShellCommandPty): boolean {
  return pty.shellCommandMarks?.incarnationId === pty.incarnationId
}

/**
 * OSC 133;D: whether it can end an agent this PTY held, meaning one seen live (by a read or its
 * own title) or one launched by the command this D closes. Consumes the running command.
 */
export function takeShellCommandFinishedAgentHold(pty: AgentHoldPty): boolean {
  // Why: a user shell integration can print 133;D at the first prompt, before the launch runs.
  const endsLaunchedCommand =
    Boolean(pty.launchAgent) &&
    ptyMarksShellCommands(pty) &&
    pty.shellCommandMarks?.commandRunning === true
  pty.shellCommandMarks = { incarnationId: pty.incarnationId, commandRunning: false }
  return (
    endsLaunchedCommand ||
    (Boolean(pty.foregroundAgent) && pty.foregroundAgentIncarnationId === pty.incarnationId) ||
    (Boolean(pty.lastAgentStatus) && pty.lastAgentStatusObservedLive)
  )
}
