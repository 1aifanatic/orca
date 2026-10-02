/** One observation per shell command; output and repeated markers cannot renew it. */
export class AgentPresenceCommandObserver {
  private readonly commands = new Map<string, { timer: ReturnType<typeof setTimeout> | null }>()

  constructor(private readonly observe: (id: string, isCurrent: () => boolean) => Promise<void>) {}

  start(id: string, isCurrent: () => boolean = () => true): void {
    if (this.commands.has(id)) {
      return
    }
    const command: { timer: ReturnType<typeof setTimeout> | null } = { timer: null }
    const current = () => this.commands.get(id) === command && isCurrent()
    command.timer = setTimeout(() => {
      command.timer = null
      if (current()) {
        void this.observe(id, current).catch(() => undefined)
      }
    }, 1_000)
    command.timer.unref?.()
    this.commands.set(id, command)
  }

  end(id: string): void {
    const command = this.commands.get(id)
    if (command?.timer) {
      clearTimeout(command.timer)
    }
    this.commands.delete(id)
  }

  stop(): void {
    for (const id of this.commands.keys()) {
      this.end(id)
    }
  }
}
