import type { AgentProcessIdentity, AgentProcessVerdict } from './agent-process-presence'

/** One probe per owner per window, however many guest events arrive. */
export const OWNER_PROBE_COOLDOWN_MS = 10_000
/** How long a guest's latest event may still take the pane once its probe finds the owner gone. */
export const HELD_GUEST_WINDOW_MS = 30_000

type OwnerProbe = { owner: string; startedAt: number; token: object }
type HeldGuest = { producer: string; heldAt: number; apply: () => void; probe?: object }

function ownerKey(owner: AgentProcessIdentity): string {
  return `${owner.platform}:${owner.pid}:${owner.startTime}`
}

/** Starts owner liveness checks for a host's panes and hands a pane to the guest that proved the
 *  owner gone. Ingest never waits on a check; the host injects its own probe. */
export class PaneOwnerProbes {
  private readonly probes = new Map<string, OwnerProbe>()
  private readonly held = new Map<string, HeldGuest>()

  constructor(
    private readonly deps: {
      /** Checks the pane's current owner; resolves `exited` only once it released the pane. */
      checkOwner: (paneKey: string) => Promise<AgentProcessVerdict | null>
      now?: () => number
    }
  ) {}

  /** A guest event: keep its latest live event (one slot per pane), and check the owner. */
  guest(
    paneKey: string,
    guest: { producer: string; holdable: boolean; apply: () => void },
    owner: AgentProcessIdentity | undefined
  ): void {
    const now = this.now()
    this.sweep(now)
    const current = this.held.get(paneKey)
    if (guest.holdable && (!current || current.producer === guest.producer)) {
      this.held.set(paneKey, {
        producer: guest.producer,
        heldAt: now,
        apply: guest.apply,
        ...(current?.probe ? { probe: current.probe } : {})
      })
    }
    if (owner) {
      this.probe(paneKey, owner, guest.holdable ? guest.producer : undefined)
    }
  }

  /** A signal other than a guest (another process of the owner's type, a terminal) doubts the owner. */
  probe(paneKey: string, owner: AgentProcessIdentity, startedBy?: string): void {
    const now = this.now()
    const key = ownerKey(owner)
    const last = this.probes.get(paneKey)
    if (last?.owner === key && now - last.startedAt < OWNER_PROBE_COOLDOWN_MS) {
      return
    }
    const token = {}
    this.probes.set(paneKey, { owner: key, startedAt: now, token })
    const held = this.held.get(paneKey)
    if (held && startedBy !== undefined && held.producer === startedBy) {
      held.probe = token
    }
    void this.deps.checkOwner(paneKey).then((verdict) => {
      if (verdict !== 'exited') {
        return
      }
      const candidate = this.held.get(paneKey)
      // Why: only the guest whose event started this probe takes over; an owner that ended on its
      // own exit keeps its resume remnant, so nothing is replayed onto it.
      if (candidate?.probe !== token || this.now() - candidate.heldAt > HELD_GUEST_WINDOW_MS) {
        return
      }
      this.held.delete(paneKey)
      candidate.apply()
    })
  }

  clear(paneKey: string): void {
    this.held.delete(paneKey)
    this.probes.delete(paneKey)
  }

  private sweep(now: number): void {
    for (const [paneKey, held] of this.held) {
      if (now - held.heldAt > HELD_GUEST_WINDOW_MS) {
        this.held.delete(paneKey)
      }
    }
    for (const [paneKey, probe] of this.probes) {
      if (now - probe.startedAt >= OWNER_PROBE_COOLDOWN_MS) {
        this.probes.delete(paneKey)
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
