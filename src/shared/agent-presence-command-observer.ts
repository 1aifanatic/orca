export type AgentPresenceObservationKind = 'command' | 'evidence'

type ShellCommand = {
  timer: ReturnType<typeof setTimeout> | null
  /** Agents whose evidence (launch, title, hook) already bought this command's read. */
  claimed: Set<string>
  evidenceTimers: Set<ReturnType<typeof setTimeout>>
}

/** One read per shell command, plus one per agent its evidence names; nothing renews either. */
export class AgentPresenceCommandObserver {
  private readonly commands = new Map<string, ShellCommand>()

  constructor(
    private readonly observe: (
      id: string,
      isCurrent: () => boolean,
      kind: AgentPresenceObservationKind
    ) => Promise<void>
  ) {}

  /** Repeats inside the pending second coalesce; a start after the read ran is the next command. */
  start(id: string, isCurrent: () => boolean = () => true): void {
    if (this.commands.get(id)?.timer) {
      return
    }
    this.end(id)
    const command = this.open(id)
    const current = () => this.commands.get(id) === command && isCurrent()
    command.timer = setTimeout(() => {
      command.timer = null
      if (current()) {
        void this.observe(id, current, 'command').catch(() => undefined)
      }
    }, 1_000)
    command.timer.unref?.()
  }

  /** Evidence naming `agent` reads at most once per command, so repeated hooks or titles cost nothing. */
  evidence(id: string, agent: string, isCurrent: () => boolean = () => true, delayMs = 0): void {
    const command = this.commands.get(id) ?? this.open(id)
    if (command.claimed.has(agent)) {
      return
    }
    command.claimed.add(agent)
    const current = () => this.commands.get(id) === command && isCurrent()
    const run = () => {
      if (current()) {
        void this.observe(id, current, 'evidence').catch(() => undefined)
      }
    }
    if (delayMs <= 0) {
      run()
      return
    }
    const timer = setTimeout(() => {
      command.evidenceTimers.delete(timer)
      run()
    }, delayMs)
    timer.unref?.()
    command.evidenceTimers.add(timer)
  }

  end(id: string): void {
    const command = this.commands.get(id)
    if (command?.timer) {
      clearTimeout(command.timer)
    }
    for (const timer of command?.evidenceTimers ?? []) {
      clearTimeout(timer)
    }
    this.commands.delete(id)
  }

  stop(): void {
    for (const id of this.commands.keys()) {
      this.end(id)
    }
  }

  private open(id: string): ShellCommand {
    const command: ShellCommand = { timer: null, claimed: new Set(), evidenceTimers: new Set() }
    this.commands.set(id, command)
    return command
  }
}
