import { isAgentForegroundWrapperProcess, recognizeAgentProcess } from './agent-process-recognition'
import { FOREGROUND_COMMAND_READS } from './foreground-command-settle'
import { isShellProcess } from './shell-process-detection'

/** What ran in a pane's foreground during its last command, as the executing host read it. */
export type CommandForeground =
  | { kind: 'agent'; agent: string }
  /** A program the recognizer does not name as an agent. */
  | { kind: 'program' }
  /** No read named it: unavailable, or only the shell or a launcher was seen. */
  | { kind: 'unknown' }

export type FinishedCommand = {
  foreground: CommandForeground
  /** Host clock at the command's start; null when the host saw no start. */
  startedAt: number | null
  /** Host clock at its end: a row reported after it is newer than the command. */
  finishedAt: number
}

export type ForegroundRead = { available: boolean; process: string | null }

type CommandState = {
  startedAt: number
  foreground: CommandForeground
  timer: ReturnType<typeof setTimeout> | null
  reading: boolean
}

function classify(read: ForegroundRead): CommandForeground {
  const process = read.available ? read.process : null
  if (!process || isShellProcess(process) || isAgentForegroundWrapperProcess(process)) {
    return { kind: 'unknown' }
  }
  const agent = recognizeAgentProcess(process)?.agent
  return agent ? { kind: 'agent', agent } : { kind: 'program' }
}

/**
 * Names the agent each command ran in a pane's foreground, from the host's process table: a read
 * after the command starts, its retries, and one on each agent event while it runs. Because every
 * read names the real foreground, a background agent's events never make it look foreground.
 */
export class CommandForegroundTracker {
  private readonly commands = new Map<string, CommandState>()

  constructor(
    private readonly deps: {
      read: (key: string) => Promise<ForegroundRead>
      now: () => number
    }
  ) {}

  started(key: string): void {
    this.forget(key)
    const state: CommandState = {
      startedAt: this.deps.now(),
      foreground: { kind: 'unknown' },
      timer: null,
      reading: false
    }
    this.commands.set(key, state)
    this.schedule(key, state, 0)
  }

  /** An agent reported in this pane: read who holds its foreground while the command runs. */
  observeActivity(key: string): void {
    const state = this.commands.get(key)
    if (state && state.foreground.kind !== 'agent') {
      void this.sample(key, state)
    }
  }

  /** Null when the pane's foreground is still not a shell: a nested shell leaked the command end. */
  async finished(key: string): Promise<FinishedCommand | null> {
    const state = this.commands.get(key)
    const finishedAt = this.deps.now()
    this.forget(key)
    const now = classify(
      await this.deps.read(key).catch(() => ({ available: false, process: null }))
    )
    if (now.kind !== 'unknown') {
      return null
    }
    return {
      foreground: state?.foreground ?? { kind: 'unknown' },
      startedAt: state?.startedAt ?? null,
      finishedAt
    }
  }

  forget(key: string): void {
    const state = this.commands.get(key)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.commands.delete(key)
  }

  private schedule(key: string, state: CommandState, retryIndex: number): void {
    const delay =
      retryIndex === 0
        ? FOREGROUND_COMMAND_READS.settleMs
        : FOREGROUND_COMMAND_READS.retryDelaysMs[retryIndex - 1]
    if (delay === undefined) {
      return
    }
    state.timer = setTimeout(() => {
      state.timer = null
      void this.sample(key, state).then(() => {
        if (this.commands.get(key) === state && state.foreground.kind !== 'agent') {
          this.schedule(key, state, retryIndex + 1)
        }
      })
    }, delay)
  }

  private async sample(key: string, state: CommandState): Promise<void> {
    if (state.reading) {
      return
    }
    state.reading = true
    try {
      const read = await this.deps.read(key).catch(() => ({ available: false, process: null }))
      if (this.commands.get(key) !== state) {
        return
      }
      const seen = classify(read)
      // Why an agent wins: a program before it (`sleep 1; codex`) never names the command's agent.
      if (
        seen.kind === 'agent' ||
        (seen.kind === 'program' && state.foreground.kind === 'unknown')
      ) {
        state.foreground = seen
      }
    } finally {
      state.reading = false
    }
  }
}
