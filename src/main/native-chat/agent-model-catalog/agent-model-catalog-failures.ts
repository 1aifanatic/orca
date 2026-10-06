import type {
  AgentSessionUnavailable,
  AgentSessionUnavailableObservation
} from '../../../shared/agent-session-availability'

// The failed listing per account, held under a short TTL so a burst of reads does not hammer a
// dead binary, then gone on its own. A probe (or the same CLI refusing a start under the same home)
// that proves the account signed out or its CLI missing types its failure. That verdict outlives
// the TTL only as a mark that the next read must re-probe, and is served until the probe that
// re-derives it answers; only that answer replaces it. A probe that found the account fine is
// remembered too, so a start failure it superseded is not shown as current.

type CatalogFailure = {
  detail: string
  failedAt: number
  /** With the agent it is about, so a sign-in change for that agent can re-derive it. */
  verdict?: { agent: string; unavailable: AgentSessionUnavailable }
}

export class AgentModelCatalogFailures {
  private readonly failures = new Map<string, CatalogFailure>()
  private readonly verified = new Set<string>()

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  active(fingerprint: string): CatalogFailure | null {
    const failure = this.failures.get(fingerprint)
    if (!failure) {
      return null
    }
    if (this.now() - failure.failedAt < this.ttlMs) {
      return failure
    }
    if (!failure.verdict) {
      this.failures.delete(fingerprint)
    }
    return null
  }

  /** The verdict while its failure is inside the TTL, or past it while `reprobing`: it stands
   *  until the probe that re-derives it answers. Unknown otherwise. */
  unavailable(
    fingerprint: string,
    reprobing: boolean
  ): AgentSessionUnavailableObservation | undefined {
    const failure = this.failures.get(fingerprint)
    if (!failure?.verdict) {
      return undefined
    }
    const left = this.ttlMs - (this.now() - failure.failedAt)
    if (left > 0) {
      return { ...failure.verdict.unavailable, expiresInMs: left }
    }
    return reprobing ? { ...failure.verdict.unavailable, expiresInMs: this.ttlMs } : undefined
  }

  /** An aged-out verdict waits for the probe that re-derives it. */
  awaitsProbe(fingerprint: string): boolean {
    return this.active(fingerprint) === null && this.failures.has(fingerprint)
  }

  /** The last probe for this account found it signed in with its CLI present. */
  accountVerified(fingerprint: string): boolean {
    return this.verified.has(fingerprint)
  }

  /** The probe's answer replaces whatever was known: its typed verdict, or none. */
  recordProbe(
    fingerprint: string,
    agent: string,
    detail: string,
    unavailable?: AgentSessionUnavailable
  ): void {
    this.write(fingerprint, {
      detail,
      failedAt: this.now(),
      ...(unavailable ? { verdict: { agent, unavailable } } : {})
    })
    if (unavailable) {
      this.verified.delete(fingerprint)
    }
  }

  /** The same CLI refused a start under this home for the reason a probe would type: that is the
   *  verdict, on the same record and with the same lifetime. */
  recordStartRefusal(fingerprint: string, agent: string, unavailable: AgentSessionUnavailable) {
    this.recordProbe(fingerprint, agent, `start refused: ${unavailable.reason}`, unavailable)
  }

  /** A chat's own listing cannot check the account, so it never replaces the probe's verdict. */
  recordListing(fingerprint: string, detail: string): void {
    if (!this.failures.get(fingerprint)?.verdict) {
      this.write(fingerprint, { detail, failedAt: this.now() })
    }
  }

  /** A listing succeeded; a chat's own listing works while signed out, so only the probe's
   *  success clears a verdict, and only it says the account was checked and found fine. */
  clear(fingerprint: string, byProbe: boolean): void {
    if (byProbe) {
      this.failures.delete(fingerprint)
      this.verified.delete(fingerprint)
      this.verified.add(fingerprint)
      evictOldest(this.verified, this.maxEntries)
    } else if (!this.failures.get(fingerprint)?.verdict) {
      this.failures.delete(fingerprint)
    }
  }

  /** The agent's sign-in changed under Orca: every verdict is re-derived by the next read's probe,
   *  and stands until it answers. */
  recheck(agent: string): void {
    for (const failure of this.failures.values()) {
      if (failure.verdict?.agent === agent) {
        failure.failedAt = Math.min(failure.failedAt, this.now() - this.ttlMs)
      }
    }
  }

  private write(fingerprint: string, failure: CatalogFailure): void {
    this.failures.delete(fingerprint)
    this.failures.set(fingerprint, failure)
    evictOldest(this.failures, this.maxEntries)
  }
}

function evictOldest(entries: Map<string, unknown> | Set<string>, max: number): void {
  for (const key of entries.keys()) {
    if (entries.size <= max) {
      return
    }
    entries.delete(key)
  }
}
