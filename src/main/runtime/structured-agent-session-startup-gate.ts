// Holds every structured chat command until host startup has settled the chats a gone process left
// with work. Every open settles its own chat too, so what the hold adds is order: each crashed turn
// gets its verdict from the death evidence startup records first, never "Couldn't confirm" from an
// open that ran before it. Commands wait at their entry, before any chat's lock (the settle takes
// those locks); none is refused. It always opens: when the settle ends, however it ends, or at a
// ceiling, so a startup fault never strands a command.

// Under the shortest client request timeout (15 s): a held command lets go before its caller gives
// up, and an open settles its own chat, so letting go early is safe.
const STARTUP_GATE_CEILING_MS = 10_000

export class StructuredAgentSessionStartupGate {
  private pending: Promise<void> | null = null
  private release: (() => void) | null = null
  private ceiling: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly ceilingMs = STARTUP_GATE_CEILING_MS) {}

  /** Closes the gate until it is opened; a no-op while it is closed. Before any request is served. */
  hold(): void {
    if (this.pending) {
      return
    }
    this.pending = new Promise((resolve) => {
      this.release = resolve
    })
    this.ceiling = setTimeout(() => {
      console.warn(
        '[structured-agent-session] startup settle still running; chat commands go ahead'
      )
      this.open()
    }, this.ceilingMs)
    this.ceiling.unref?.()
  }

  /** Opens once the settle ends, whether it settled or failed. */
  openWhen(settled: Promise<unknown>): void {
    void settled
      .catch((error: unknown) => {
        console.warn('[structured-agent-session] startup settle failed', error)
      })
      .finally(() => this.open())
  }

  open(): void {
    if (this.ceiling) {
      clearTimeout(this.ceiling)
      this.ceiling = null
    }
    this.release?.()
    this.release = null
    this.pending = null
  }

  /** What a chat command waits for, or null when the gate is open. */
  ready = (): Promise<void> | null => this.pending
}
