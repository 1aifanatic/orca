// Holds every structured chat command until host startup has settled the chats a gone process left
// with work. Every open settles its own chat too, so what the hold adds is order: each crashed turn
// gets its verdict from the death evidence startup records first, never "Couldn't confirm" from an
// open that ran before it. Commands wait at their entry, before any chat's lock (the settle takes
// those locks); none is refused. It always opens: when the settle ends, however it ends, or at a
// ceiling, so a startup fault never strands a command.

// Under the shortest client request timeout (15 s), counted from launch (`hold`): a held command
// lets go before its caller gives up, and an open settles its own chat, so letting go early is
// safe. Past it, the order is what is lost: a crashed turn may get its verdict from an open.
const STARTUP_GATE_CEILING_MS = 10_000

type StartupGateOpener =
  | 'settle ended'
  | 'settle failed'
  | 'step failed'
  | 'ceiling'
  | 'nothing to settle'

export class StructuredAgentSessionStartupGate {
  private pending: Promise<void> | null = null
  private release: (() => void) | null = null
  private ceiling: ReturnType<typeof setTimeout> | null = null
  // One timing line per launch, for the startup measurements: written once the gate is open and
  // the step is over (or never started).
  private heldAt: number | null = null
  private step: { startedAt: number; endedAt: number | null } | null = null
  private opened: { at: number; by: StartupGateOpener } | null = null

  constructor(
    private readonly ceilingMs = STARTUP_GATE_CEILING_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Closes the gate until it is opened; a no-op while it is closed. Before any request is served. */
  hold(): void {
    if (this.pending) {
      return
    }
    this.heldAt = this.now()
    this.pending = new Promise((resolve) => {
      this.release = resolve
    })
    this.ceiling = setTimeout(() => {
      console.warn(
        '[structured-agent-session] startup settle still running; chat commands go ahead'
      )
      this.open('ceiling')
    }, this.ceilingMs)
    this.ceiling.unref?.()
  }

  /** The startup step began; only timed. */
  stepStarted(): void {
    this.step ??= { startedAt: this.now(), endedAt: null }
  }

  /** Opens once the settle ends, whether it settled or failed. */
  openWhen(settled: Promise<unknown>): void {
    void settled.then(
      () => this.endStep('settle ended'),
      (error: unknown) => {
        console.warn('[structured-agent-session] startup settle failed', error)
        this.endStep('settle failed')
      }
    )
  }

  /** Opens now: the step ended with nothing to settle, or failed before its settle began. */
  open(by: StartupGateOpener = 'nothing to settle'): void {
    if (this.ceiling) {
      clearTimeout(this.ceiling)
      this.ceiling = null
    }
    if (this.pending && !this.opened) {
      this.opened = { at: this.now(), by }
      if ((by === 'nothing to settle' || by === 'step failed') && this.step?.endedAt === null) {
        this.step.endedAt = this.opened.at
      }
    }
    this.release?.()
    this.release = null
    this.pending = null
    this.report()
  }

  /** What a chat command waits for, or null when the gate is open. */
  ready = (): Promise<void> | null => this.pending

  private endStep(by: StartupGateOpener): void {
    if (this.step && this.step.endedAt === null) {
      this.step.endedAt = this.now()
    }
    this.open(by)
  }

  private report(): void {
    const { heldAt, step, opened } = this
    if (heldAt === null || !opened || (step && step.endedAt === null)) {
      return
    }
    const since = (at: number | null | undefined) => (at == null ? 'never' : `+${at - heldAt} ms`)
    console.info(
      `[structured-agent-session] startup gate: held at launch; step started ${since(step?.startedAt)}, ` +
        `ended ${since(step?.endedAt)}; opened ${since(opened.at)} by ${opened.by}`
    )
    this.heldAt = null
  }
}
