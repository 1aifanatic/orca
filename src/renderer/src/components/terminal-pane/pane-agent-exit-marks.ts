/** 'read-confirmed': a read in this PTY saw the agent live first. 'marked': its own title, or a
 *  133;D closing a command the shell started, brackets the exit. 'none': only an expectation. */
export type ConfirmedShellAgentExit = 'none' | 'marked' | 'read-confirmed'

/**
 * What lets a confirmed shell count as an agent exit. Each mark keeps the PTY key (id plus host
 * incarnation) it was seen in, because the pane's tracker outlives a PTY replacement.
 */
export function createPaneAgentExitMarks(seesShellCommandMarks?: () => boolean): {
  agentSeenLive: (ptyKey: string) => void
  agentTitleObserved: (ptyKey: string) => void
  commandStarted: (shellMarkedPtyKey: string | null) => void
  commandFinished: (ptyKey: string | null) => void
  marksCommands: (ptyKey: string) => boolean
  classifyConfirmedShell: (
    ptyKey: string,
    reason: 'visible-pty' | 'command-finished'
  ) => ConfirmedShellAgentExit
} {
  let seenLive: string | null = null
  let observed: string | null = null
  // Why: a user shell integration can print 133;D at the first prompt, before the launch runs.
  let runningCommand: string | null = null
  let closedCommand: string | null = null
  // The PTY key whose shell has printed an OSC 133 mark; see isAgentExitBlind.
  let marked: string | null = null
  return {
    agentSeenLive(ptyKey) {
      seenLive = ptyKey
      observed = ptyKey
    },
    agentTitleObserved(ptyKey) {
      observed = ptyKey
    },
    commandStarted(shellMarkedPtyKey) {
      // Why: a new command means an earlier sighting describes the previous one.
      seenLive = null
      runningCommand = shellMarkedPtyKey ?? runningCommand
      marked = shellMarkedPtyKey ?? marked
    },
    commandFinished(ptyKey) {
      closedCommand = runningCommand
      runningCommand = null
      marked = ptyKey ?? marked
    },
    marksCommands(ptyKey) {
      // Why: a pane that cannot see its shell's marks never calls itself blind for lacking them.
      return seesShellCommandMarks?.() === false || marked === ptyKey
    },
    classifyConfirmedShell(ptyKey, reason) {
      const exit =
        seenLive === ptyKey
          ? 'read-confirmed'
          : observed === ptyKey || (reason === 'command-finished' && closedCommand === ptyKey)
            ? 'marked'
            : 'none'
      seenLive = null
      observed = null
      return exit
    }
  }
}
