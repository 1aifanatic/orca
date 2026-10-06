import {
  AGENT_SESSION_AVAILABILITY_TTL_MS,
  type AgentSessionUnavailable,
  type AgentSessionUnavailableObservation
} from '../../../shared/agent-session-availability'

// What the session-less probe last proved about an account's sign-in or CLI, held beside the
// model catalog and never inside it: a live session's listing can neither set nor clear it.
// Memory-only and expiring, so a stale blocker dies on its own and the next probe re-derives it.

export class AgentModelCatalogUnavailableError extends Error {
  constructor(readonly unavailable: AgentSessionUnavailable) {
    super(unavailable.reason)
  }
}

export function evictOldestOverCap(entries: Map<string, unknown>, max: number): void {
  while (entries.size > max) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) {
      return
    }
    entries.delete(oldest)
  }
}

export class AgentModelCatalogAvailability {
  private readonly blockers = new Map<
    string,
    { unavailable: AgentSessionUnavailable; observedAt: number }
  >()
  private readonly probedAt = new Map<string, number>()

  constructor(
    private readonly now: () => number,
    private readonly maxEntries: number
  ) {}

  /** A settled probe's answer replaces what was known: its blocker, or none. */
  recordProbe(fingerprint: string, unavailable?: AgentSessionUnavailable): void {
    const at = this.now()
    this.blockers.delete(fingerprint)
    if (unavailable) {
      this.blockers.set(fingerprint, { unavailable, observedAt: at })
    }
    this.probedAt.delete(fingerprint)
    this.probedAt.set(fingerprint, at)
    evictOldestOverCap(this.blockers, this.maxEntries)
    evictOldestOverCap(this.probedAt, this.maxEntries)
  }

  unavailable(fingerprint: string): AgentSessionUnavailableObservation | undefined {
    const observation = this.blockers.get(fingerprint)
    if (!observation) {
      return undefined
    }
    const expiresInMs = AGENT_SESSION_AVAILABILITY_TTL_MS - (this.now() - observation.observedAt)
    if (expiresInMs <= 0) {
      this.blockers.delete(fingerprint)
      return undefined
    }
    return { ...observation.unavailable, expiresInMs }
  }

  shouldProbe(fingerprint: string): boolean {
    const checkedAt = this.probedAt.get(fingerprint)
    return checkedAt === undefined || this.now() - checkedAt >= AGENT_SESSION_AVAILABILITY_TTL_MS
  }
}
