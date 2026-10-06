import {
  AGENT_SESSION_AVAILABILITY_MAX_HOLD_MS,
  agentSessionAvailabilityState,
  type AgentSessionAvailability,
  type AgentSessionAvailabilityState,
  type AgentSessionUnavailable
} from '../../../shared/agent-session-availability'

// Whether a new child can start under each account home: what the session-less probe last found,
// or what the same CLI said refusing a start there. Its own record with its own writers, never part
// of the model catalog or its failure backoff. In memory only and capped; an entry lives until a
// newer answer replaces it, an untyped probe failure makes it unknown, the cap evicts it, or the
// process restarts. A blocked answer is re-derived by the next read's probe, and served until that
// probe answers, once an account change follows it, once a person's read finds it older than the
// TTL, or once the client's own timer read finds it past its backed-off hold.

/** The probe's typed verdict that no new child can start under this account. */
export class AgentModelCatalogUnavailableError extends Error {
  constructor(readonly unavailable: AgentSessionUnavailable) {
    super(unavailable.reason)
  }
}

/** When evidence was taken: `order` says which is newer, whatever the clock does; `at` ages it. */
export type AgentAccountEvidence = { order: number; at: number }

export type AgentAccountStatus = AgentSessionAvailabilityState & {
  agent: string
  /** The probe's start, or the refused start. */
  taken: AgentAccountEvidence
  /** Probes in a row that found this same blocked state; each doubles the hold before the next. */
  streak: number
}

function sameState(left: AgentSessionAvailabilityState, right: AgentSessionAvailabilityState) {
  return (
    left.state === right.state &&
    (left.state !== 'notSignedIn' ||
      (right.state === 'notSignedIn' && left.account === right.account))
  )
}

export class AgentAccountStatuses {
  private readonly statuses = new Map<string, AgentAccountStatus>()
  /** The probe running for each home, by the evidence it will record. */
  private readonly probing = new Map<string, AgentAccountEvidence & { agent: string }>()
  /** Each agent's last account change, by sequence: evidence taken before it is the old account's. */
  private readonly rechecks = new Map<string, number>()
  private sequence = 0

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
    const left = this.holdLeft(status)
    // With nothing to re-derive it, a blocked answer must die with its hold.
    if (!rederivable && left <= 0) {
      return undefined
    }
    const recheckInMs = left > 0 && !this.marked(status) ? left : this.ttlMs
    return status.state === 'notSignedIn'
      ? {
          state: 'notSignedIn',
          ...(status.account ? { account: status.account } : {}),
          recheckInMs
        }
      : { state: 'cliMissing', recheckInMs }
  }

  /** The answer held now, as a handle `blockedAfter` compares against. Every write replaces the
   *  object, so identity means "no newer answer". */
  held(fingerprint: string): AgentAccountStatus | undefined {
    return this.statuses.get(fingerprint)
  }

  /** A blocked answer arrived after `held` was taken. */
  blockedAfter(fingerprint: string, held: AgentAccountStatus | undefined): boolean {
    const status = this.statuses.get(fingerprint)
    return status !== undefined && status !== held && status.state !== 'ready'
  }

  /** True when this read should start the probe: marked by an account change, or blocked past the
   *  TTL for a person's read. Only the client's timer read waits out the backed-off hold, so
   *  someone back from signing in elsewhere is re-checked within the TTL. */
  needsProbe(fingerprint: string, scheduled = false): boolean {
    const status = this.statuses.get(fingerprint)
    if (!status) {
      return false
    }
    if (this.marked(status)) {
      return true
    }
    if (status.state === 'ready') {
      return false
    }
    const age = this.now() - status.taken.at
    return scheduled ? this.holdLeft(status) <= 0 : age < 0 || age >= this.ttlMs
  }

  /** The probe running now began before the account change it would have to answer for. */
  probeStartedBeforeRecheck(fingerprint: string): boolean {
    const running = this.probing.get(fingerprint)
    return running !== undefined && running.order < this.lastRecheck(running.agent)
  }

  beginProbe(fingerprint: string, agent: string): AgentAccountEvidence {
    const taken = this.evidence()
    this.probing.set(fingerprint, { ...taken, agent })
    return taken
  }

  /** A probe's answer; null is unknown. */
  recordProbe(
    fingerprint: string,
    agent: string,
    state: AgentSessionAvailabilityState | null,
    taken: AgentAccountEvidence
  ): void {
    if (this.probing.get(fingerprint)?.order === taken.order) {
      this.probing.delete(fingerprint)
    }
    this.write(fingerprint, agent, state, taken, true)
  }

  /** A probe that failed: typed, it is the blocked answer; any other failure is unknown. */
  recordProbeFailure(
    fingerprint: string,
    agent: string,
    error: unknown,
    taken: AgentAccountEvidence
  ): void {
    const typed = error instanceof AgentModelCatalogUnavailableError
    this.recordProbe(
      fingerprint,
      agent,
      typed ? agentSessionAvailabilityState(error.unavailable) : null,
      taken
    )
  }

  /** What the same CLI said refusing a start under this home just now. */
  record(fingerprint: string, agent: string, state: AgentSessionAvailabilityState): void {
    this.write(fingerprint, agent, state, this.evidence(), false)
  }

  /** The agent's sign-in changed under Orca: each of its answers is re-derived by the next read's
   *  probe, served until that probe answers, and its hold starts over. A probe already running,
   *  even the home's first, read the old account. */
  recheck(agent: string): void {
    this.rechecks.set(agent, ++this.sequence)
  }

  private lastRecheck(agent: string): number {
    return this.rechecks.get(agent) ?? -Infinity
  }

  private marked(status: AgentAccountStatus): boolean {
    return this.lastRecheck(status.agent) > status.taken.order
  }

  private evidence(): AgentAccountEvidence {
    return { order: ++this.sequence, at: this.now() }
  }

  /** A clock that stepped back makes the answer due now rather than frozen. */
  private holdLeft(status: AgentAccountStatus): number {
    const age = this.now() - status.taken.at
    const hold = Math.min(
      this.ttlMs * 2 ** (status.streak - 1),
      AGENT_SESSION_AVAILABILITY_MAX_HOLD_MS
    )
    return age < 0 ? 0 : hold - age
  }

  /** Evidence older than what is held, or than an account change, never replaces it. */
  private write(
    fingerprint: string,
    agent: string,
    state: AgentSessionAvailabilityState | null,
    taken: AgentAccountEvidence,
    probed: boolean
  ): void {
    const held = this.statuses.get(fingerprint)
    if (taken.order < Math.max(held?.taken.order ?? -Infinity, this.lastRecheck(agent))) {
      return
    }
    this.statuses.delete(fingerprint)
    if (!state) {
      return
    }
    // Only a probe repeating the same blocked answer backs off; a refused start keeps the pace.
    const repeated =
      held !== undefined && !this.marked(held) && state.state !== 'ready' && sameState(held, state)
    const streak = !repeated ? 1 : probed ? held.streak + 1 : held.streak
    this.statuses.set(fingerprint, { ...state, agent, taken, streak })
    for (const key of this.statuses.keys()) {
      if (this.statuses.size <= this.maxEntries) {
        return
      }
      this.statuses.delete(key)
    }
  }
}
