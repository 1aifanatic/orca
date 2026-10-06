import type {
  AgentSessionUnavailable,
  AgentSessionUnavailableObservation
} from '../../../shared/agent-session-availability'

// The failed listing per account, held under a short TTL so a burst of reads does not hammer a
// dead binary, then gone on its own. A probe that proves the account signed out or its CLI
// missing types its failure; that verdict outlives the TTL only as a mark that the next read
// must re-probe, and only another probe replaces it.

type CatalogFailure = { detail: string; failedAt: number; unavailable?: AgentSessionUnavailable }

export class AgentModelCatalogFailures {
  private readonly failures = new Map<string, CatalogFailure>()

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
    if (!failure.unavailable) {
      this.failures.delete(fingerprint)
    }
    return null
  }

  /** The probe's verdict while its failure is inside the TTL; unknown otherwise. */
  unavailable(fingerprint: string): AgentSessionUnavailableObservation | undefined {
    const failure = this.active(fingerprint)
    return failure?.unavailable
      ? { ...failure.unavailable, expiresInMs: this.ttlMs - (this.now() - failure.failedAt) }
      : undefined
  }

  /** An aged-out verdict waits for the probe that re-derives it. */
  awaitsProbe(fingerprint: string): boolean {
    return this.active(fingerprint) === null && this.failures.has(fingerprint)
  }

  /** The probe's answer replaces whatever was known: its typed verdict, or none. */
  recordProbe(fingerprint: string, detail: string, unavailable?: AgentSessionUnavailable): void {
    this.failures.delete(fingerprint)
    this.failures.set(fingerprint, {
      detail,
      failedAt: this.now(),
      ...(unavailable ? { unavailable } : {})
    })
    for (const key of this.failures.keys()) {
      if (this.failures.size <= this.maxEntries) {
        return
      }
      this.failures.delete(key)
    }
  }

  /** A chat's own listing cannot check the account, so it never replaces the probe's verdict. */
  recordListing(fingerprint: string, detail: string): void {
    if (!this.failures.get(fingerprint)?.unavailable) {
      this.recordProbe(fingerprint, detail)
    }
  }

  /** A listing succeeded; a chat's own listing works while signed out, so only the probe's
   *  success clears a verdict. */
  clear(fingerprint: string, byProbe: boolean): void {
    if (byProbe || !this.failures.get(fingerprint)?.unavailable) {
      this.failures.delete(fingerprint)
    }
  }
}
