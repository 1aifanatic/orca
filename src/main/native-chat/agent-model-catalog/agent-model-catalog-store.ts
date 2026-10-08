import type {
  AgentSessionFastModeSupport,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentModelCatalogPersistence } from './agent-model-catalog-persistence'
import {
  agentModelCatalogEntry,
  type AgentModelCatalogEntry,
  type AgentModelCatalogListing
} from './agent-model-catalog-entry'

export type {
  AgentModelCatalogEntry,
  AgentModelCatalogListing,
  AgentModelCatalogLiveListing
} from './agent-model-catalog-entry'
export { withLiveCatalogListing } from './agent-model-catalog-entry'

// The execution host's one model catalog per (agent, launch fingerprint):
// served immediately at any age, refreshed in the background when old, and
// written through by every successful listing a live session already performs.
// Each entry keeps two listings: the last account-level discovery (the only
// source of the configured default and default efforts, and the only clock a
// refresh follows) and the last live session's listing (which models exist and
// their efforts). Readers see the two merged; neither write erases the other.
// Success-only: a failure, timeout or empty list is never stored as a catalog
// and never persisted — it is held separately under a short TTL so a burst of
// picker opens does not hammer a dead binary, then dies on its own.

export const AGENT_MODEL_CATALOG_FRESH_MS = 10 * 60_000
export const AGENT_MODEL_CATALOG_FAILURE_TTL_MS = 30_000
export const AGENT_MODEL_CATALOG_PICKER_WAIT_MS = 30_000
export const AGENT_MODEL_CATALOG_MAX_ENTRIES = 256

/** `discovery`: an account-level listing that names the configured default and owns freshness.
 *  `live`: what a running session listed — which models exist and their efforts, nothing more. */
export type AgentModelCatalogSource = 'discovery' | 'live'

export type AgentModelCatalogSuccess = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  fastModeTierByModel: ReadonlyMap<string, string>
  origin: 'live-session' | 'probe'
  /** A row only this session's launch added (its own `--model`): kept only once the account's
   *  catalog already lists that model. */
  launchOnlyModelId?: string
}

/** Lists an agent's models without a session, under the account a launch would pin. */
export type AgentModelCatalogProbe = (
  accountHome: AgentSessionAccountHome
) => Promise<AgentModelCatalogSuccess>

/** Who lists, by identity: a live session's per-spawn handle, or the session-less probe. */
export type AgentModelCatalogLister = AgentModelCatalogSessionAccess | AgentModelCatalogProbe

type CatalogFailure = { detail: string; failedAt: number }

type InFlightListings = Map<AgentModelCatalogLister, Promise<AgentModelCatalogEntry | null>>

/** A live session's handle into the store, pinned at spawn to the account home
 *  THAT child launched under — an account switched afterwards must never
 *  receive or poison this session's listing. */
export type AgentModelCatalogSessionAccess = {
  store: AgentModelCatalogStore
  fingerprint: string
  accountHomePath: string
}

function tierRecord(tiers: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(tiers.entries())
}

function listingKey(entry: AgentModelCatalogEntry): string {
  const facts = (listing: AgentModelCatalogListing | null): unknown =>
    listing && [
      listing.origin,
      listing.models,
      listing.fastModeSupport ?? null,
      listing.fastModeTierByModel
    ]
  return JSON.stringify([facts(entry.discovered), facts(entry.live)])
}

export class AgentModelCatalogStore {
  private readonly entries = new Map<string, AgentModelCatalogEntry>()
  private readonly failures = new Map<string, CatalogFailure>()
  private readonly refreshes = new Map<string, InFlightListings>()
  private readonly listingWaiters = new Map<string, Set<() => void>>()
  private readonly latestWrittenOrder = new Map<string, number>()
  private nextListingOrder = 0
  private persistence: AgentModelCatalogPersistence | null = null
  private readonly now: () => number

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now
  }

  /** Hydrates last-good entries from disk. Anything this run already listed wins. */
  async attachPersistence(persistence: AgentModelCatalogPersistence): Promise<void> {
    this.persistence = persistence
    for (const entry of await persistence.load()) {
      if (!this.entries.has(entry.fingerprint)) {
        this.entries.set(entry.fingerprint, entry)
      }
    }
    this.evictOverCap()
  }

  flushPersistence(): Promise<void> {
    return this.persistence?.flush() ?? Promise.resolve()
  }

  get(fingerprint: string): AgentModelCatalogEntry | null {
    const entry = this.entries.get(fingerprint)
    if (!entry) {
      return null
    }
    // Refresh recency for the LRU cap.
    this.entries.delete(fingerprint)
    this.entries.set(fingerprint, entry)
    return entry
  }

  /** Only a discovery ages: live saves never postpone the next account-level listing. */
  isStale(entry: AgentModelCatalogEntry): boolean {
    return !entry.discovered || this.now() - entry.discovered.at >= AGENT_MODEL_CATALOG_FRESH_MS
  }

  failureDetail(fingerprint: string): string | null {
    return this.hasActiveFailure(fingerprint)
      ? (this.failures.get(fingerprint)?.detail ?? null)
      : null
  }

  hasActiveFailure(fingerprint: string): boolean {
    const failure = this.failures.get(fingerprint)
    if (!failure) {
      return false
    }
    if (this.now() - failure.failedAt >= AGENT_MODEL_CATALOG_FAILURE_TTL_MS) {
      this.failures.delete(fingerprint)
      return false
    }
    return true
  }

  /** The one ingestion step every listing goes through, whoever listed it. */
  recordSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ): AgentModelCatalogEntry | null {
    const entry = this.writeSuccess(fingerprint, agent, success, source, ++this.nextListingOrder)
    this.notifyListingWaiters(fingerprint)
    return entry
  }

  private entryFromSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ): AgentModelCatalogEntry | null {
    const previous = this.entries.get(fingerprint)
    const launchOnly = success.launchOnlyModelId
    const models =
      launchOnly !== undefined && !previous?.models.some((model) => model.id === launchOnly)
        ? success.models.filter((model) => model.id !== launchOnly)
        : success.models
    if (models.length === 0) {
      // An empty list identifies no model; it is doubt, not a catalog.
      return null
    }
    const listing: AgentModelCatalogListing = {
      models: models.map((model) => ({ ...model })),
      ...(success.fastModeSupport ? { fastModeSupport: success.fastModeSupport } : {}),
      fastModeTierByModel: tierRecord(success.fastModeTierByModel),
      origin: success.origin,
      at: this.now()
    }
    return source === 'discovery'
      ? agentModelCatalogEntry(agent, fingerprint, listing, previous?.live ?? null)
      : agentModelCatalogEntry(agent, fingerprint, previous?.discovered ?? null, listing)
  }

  private writeSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource,
    order: number
  ): AgentModelCatalogEntry | null {
    const entry = this.entryFromSuccess(fingerprint, agent, success, source)
    if (!entry) {
      return null
    }
    const previous = this.entries.get(fingerprint)
    this.entries.delete(fingerprint)
    this.entries.set(fingerprint, entry)
    if (source === 'discovery' && this.refreshes.has(fingerprint)) {
      this.latestWrittenOrder.set(fingerprint, order)
    }
    if (source === 'discovery') {
      this.failures.delete(fingerprint)
    }
    this.evictOverCap()
    // Live sessions re-list every turn; an unchanged listing only refreshes the in-memory age.
    if (!previous || listingKey(previous) !== listingKey(entry)) {
      this.persistence?.save([...this.entries.values()])
    }
    return entry
  }

  recordFailure(fingerprint: string, detail: string): void {
    this.failures.set(fingerprint, { detail, failedAt: this.now() })
  }

  /** A discovery listing. Joins an in-flight refresh by the same lister rather than starting a second. Never
   *  joins another lister's: a probe or another chat's Codex that hangs must not decide
   *  whether this chat starts. Resolves with the entry on success, null on failure. */
  refresh(
    fingerprint: string,
    agent: string,
    lister: AgentModelCatalogLister,
    listModels: () => Promise<AgentModelCatalogSuccess>
  ): Promise<AgentModelCatalogEntry | null> {
    const listers: InFlightListings = this.refreshes.get(fingerprint) ?? new Map()
    const inFlight = listers.get(lister)
    if (inFlight) {
      return inFlight
    }
    const settle = (): void => {
      listers.delete(lister)
      if (listers.size === 0 && this.refreshes.get(fingerprint) === listers) {
        this.refreshes.delete(fingerprint)
        this.latestWrittenOrder.delete(fingerprint)
      }
      this.notifyListingWaiters(fingerprint)
    }
    const order = ++this.nextListingOrder
    const run = listModels().then(
      (success) => {
        // An older lister still receives its own result, but cannot replace a newer discovery.
        const entry =
          (this.latestWrittenOrder.get(fingerprint) ?? 0) > order && this.entries.has(fingerprint)
            ? this.entryFromSuccess(fingerprint, agent, success, 'discovery')
            : this.writeSuccess(fingerprint, agent, success, 'discovery', order)
        settle()
        return entry
      },
      (error: unknown) => {
        settle()
        this.recordFailure(fingerprint, error instanceof Error ? error.message : String(error))
        return null
      }
    )
    listers.set(lister, run)
    this.refreshes.set(fingerprint, listers)
    return run
  }

  /** A picker follows the current account work until a catalog lands, all work ends,
   *  or its fixed deadline expires. */
  pendingListing(fingerprint: string): Promise<AgentModelCatalogEntry | null> | null {
    if (!this.refreshes.has(fingerprint)) {
      return null
    }
    return new Promise((resolve) => {
      const waiters = this.listingWaiters.get(fingerprint) ?? new Set<() => void>()
      let settled = false
      const finish = (entry: AgentModelCatalogEntry | null): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(deadline)
        waiters.delete(check)
        if (waiters.size === 0) {
          this.listingWaiters.delete(fingerprint)
        }
        resolve(entry)
      }
      const check = (): void => {
        const entry = this.get(fingerprint)
        if (entry || !this.refreshes.has(fingerprint)) {
          finish(entry)
        }
      }
      const deadline = setTimeout(
        () => finish(this.get(fingerprint)),
        AGENT_MODEL_CATALOG_PICKER_WAIT_MS
      )
      waiters.add(check)
      this.listingWaiters.set(fingerprint, waiters)
      check()
    })
  }

  private notifyListingWaiters(fingerprint: string): void {
    for (const check of this.listingWaiters.get(fingerprint) ?? []) {
      check()
    }
  }

  /** True when a read should kick a background refresh: nothing known or the
   *  entry aged out, and no failure is still inside its TTL. */
  shouldRefresh(fingerprint: string): boolean {
    if (this.refreshes.has(fingerprint) || this.hasActiveFailure(fingerprint)) {
      return false
    }
    const entry = this.entries.get(fingerprint)
    return !entry || this.isStale(entry)
  }

  private evictOverCap(): void {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= AGENT_MODEL_CATALOG_MAX_ENTRIES) {
        return
      }
      this.entries.delete(key)
    }
  }
}

/** The host process's one store. Persistence is attached where the app knows
 *  its state directory; unit tests build their own store instead. */
export const agentModelCatalogStore = new AgentModelCatalogStore()
