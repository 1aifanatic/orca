import {
  agentSessionAvailabilityState,
  type AgentSessionAvailability,
  type AgentSessionAvailabilityState,
  type AgentSessionUnavailable
} from '../../../shared/agent-session-availability'

// Whether a new child can start under each account home: what the session-less probe last found,
// or what the same CLI said refusing a start there. Its own record with its own writers, never part
// of the model catalog or its failure backoff. In memory only and capped; an entry lives until a
// newer answer replaces it, an untyped probe failure makes it unknown, the cap evicts it, or the
// process restarts. A blocked answer older than the TTL, or one an account change marked, is
// re-derived by the next read's probe and served until that probe answers.

/** The probe's typed verdict that no new child can start under this account. */
export class AgentModelCatalogUnavailableError extends Error {
  constructor(readonly unavailable: AgentSessionUnavailable) {
    super(unavailable.reason)
  }
}

type AgentAccountStatus = AgentSessionAvailabilityState & {
  agent: string
  /** When the evidence was taken: the probe's start, or the refused start. */
  checkedAt: number
  /** An account change after `checkedAt`: the next read re-probes, and older evidence is ignored. */
  recheckAt?: number
}

export class AgentAccountStatuses {
  private readonly statuses = new Map<string, AgentAccountStatus>()

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  /** Served at any age until replaced; `recheckInMs` tells a blocked reader when to read again. */
  get(fingerprint: string, rederivable: boolean): AgentSessionAvailability | undefined {
    const status = this.statuses.get(fingerprint)
    if (!status) {
      return undefined
    }
    if (status.state === 'ready') {
      return { state: 'ready' }
    }
    const left = this.ttlMs - (this.now() - status.checkedAt)
    // With nothing to re-derive it, a blocked answer must die with its TTL.
    if (!rederivable && left <= 0) {
      return undefined
    }
    const recheckInMs = left > 0 && status.recheckAt === undefined ? left : this.ttlMs
    return status.state === 'notSignedIn'
      ? {
          state: 'notSignedIn',
          ...(status.account ? { account: status.account } : {}),
          recheckInMs
        }
      : { state: 'cliMissing', recheckInMs }
  }

  /** The answer held now, as a handle `blockedAfter` compares against. */
  held(fingerprint: string): object | undefined {
    return this.statuses.get(fingerprint)
  }

  /** A blocked answer arrived after `held` was taken. */
  blockedAfter(fingerprint: string, held: object | undefined): boolean {
    const status = this.statuses.get(fingerprint)
    return status !== undefined && status !== held && status.state !== 'ready'
  }

  /** True when the next read should start the probe: blocked past the TTL, or marked. */
  needsProbe(fingerprint: string): boolean {
    const status = this.statuses.get(fingerprint)
    return (
      status !== undefined &&
      (status.recheckAt !== undefined ||
        (status.state !== 'ready' && this.now() - status.checkedAt >= this.ttlMs))
    )
  }

  /** An answer taken at `checkedAt`; null is unknown. Older evidence than what is held, or than an
   *  account change, never replaces it. */
  record(
    fingerprint: string,
    agent: string,
    state: AgentSessionAvailabilityState | null,
    checkedAt: number = this.now()
  ): void {
    const held = this.statuses.get(fingerprint)
    if (held && checkedAt < Math.max(held.checkedAt, held.recheckAt ?? -Infinity)) {
      return
    }
    this.statuses.delete(fingerprint)
    if (!state) {
      return
    }
    this.statuses.set(fingerprint, { ...state, agent, checkedAt })
    for (const key of this.statuses.keys()) {
      if (this.statuses.size <= this.maxEntries) {
        return
      }
      this.statuses.delete(key)
    }
  }

  /** A probe that failed: typed, it is the blocked answer; any other failure is unknown. */
  recordProbeFailure(fingerprint: string, agent: string, error: unknown, checkedAt: number): void {
    const typed = error instanceof AgentModelCatalogUnavailableError
    this.record(
      fingerprint,
      agent,
      typed ? agentSessionAvailabilityState(error.unavailable) : null,
      checkedAt
    )
  }

  /** The agent's sign-in changed under Orca: each of its answers is re-derived by the next read's
   *  probe, and served until that probe answers. */
  recheck(agent: string): void {
    const at = this.now()
    for (const status of this.statuses.values()) {
      if (status.agent === agent) {
        status.recheckAt = at
      }
    }
  }
}
