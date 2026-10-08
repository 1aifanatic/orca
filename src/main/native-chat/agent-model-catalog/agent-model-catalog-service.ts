import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import type {
  AgentModelCatalogEntry,
  AgentModelCatalogLiveListing,
  AgentModelCatalogProbe,
  AgentModelCatalogStore
} from './agent-model-catalog-store'

export type AgentModelCatalogServiceDeps = {
  store: AgentModelCatalogStore
  getRecord: (sessionId: string) => AgentSessionRecord | undefined
  /** Whether this build can start the record's agent as the record pins it; a record it cannot
   *  names no account a probe may start that agent's CLI under. */
  drivesRecord: (record: AgentSessionRecord) => boolean
  /** The account home a structured launch for this agent would pin right now —
   *  the SAME resolver the create path fills `record.accountHome` with, so a
   *  record-less read can never answer from another account's listing. */
  resolveAccountHome: (agent: string) => Promise<AgentSessionAccountHome>
  /** Session-less listers, one per agent that has one on this host. */
  probes?: Readonly<Partial<Record<string, AgentModelCatalogProbe>>>
  /** Agents whose listing marks the model the account is configured to run as its default. */
  listingNamesConfiguredModel?: ReadonlySet<string>
  /** Where a session's provider runs, for deciding whether its own config scope is the account's. */
  recordWorkspacePath?: (record: AgentSessionRecord) => Promise<string | null>
  /** Whether the workspace's own config could pick a model other than the listed default. */
  workspaceMayOverrideDefaultModel?: (input: {
    agent: string
    workspacePath: string
    accountHomePath: string
  }) => Promise<boolean>
}

export type AgentModelCatalogService = {
  read: (params: {
    agent: string
    sessionId?: string
    /** Where a new chat would run; null when one was named but is not a local directory. */
    workspacePath?: string | null
    /** With no entry yet, answer from the listing this read starts or joins instead of `unknown`. */
    waitForListing?: boolean
  }) => Promise<AgentSessionModelCatalogResult>
  /** Saves what a running session listed as its account's catalog, so the next chat starts warm. */
  recordLiveListing: (sessionId: string, listing: AgentModelCatalogLiveListing) => void
  /** Lists, in the background, every agent whose catalog for the account a new chat would pin is
   *  missing or old, so a picker never meets a cold catalog. Resolves once those listings settle. */
  prewarm: () => Promise<void>
}

// At most this many agents list at once: each listing spawns that agent's CLI.
const PREWARM_CONCURRENCY = 2

function resultFromEntry(
  entry: AgentModelCatalogEntry,
  namesDefault: boolean,
  listingNamesConfiguredModel: boolean
): AgentSessionModelCatalogResult {
  // A CLI-resolved default names the configured model even where the listing names none.
  const namesConfigured = listingNamesConfiguredModel || entry.configured !== null
  return {
    origin: entry.origin,
    // Without a default the picker names nothing until the chat reports its model.
    models: entry.models.map((model) =>
      namesDefault ? { ...model } : { ...model, isDefault: false }
    ),
    ...(entry.fastModeSupport ? { fastModeSupport: entry.fastModeSupport } : {}),
    fetchedAt: entry.fetchedAt,
    listingNamesConfiguredModel: namesDefault && namesConfigured
  }
}

/** A named workspace keeps the listed default only when none of its own config can replace it. */
async function workspaceKeepsListedDefault(
  deps: AgentModelCatalogServiceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  accountHomePath: string | null
): Promise<boolean> {
  if (workspacePath === undefined) {
    return true
  }
  if (workspacePath === null || !accountHomePath || !deps.workspaceMayOverrideDefaultModel) {
    return false
  }
  try {
    return !(await deps.workspaceMayOverrideDefaultModel({ agent, workspacePath, accountHomePath }))
  } catch {
    return false
  }
}

/** The catalog a new chat of `agent` would read: the account a launch would pin right now. */
async function newChatCatalogKey(
  deps: AgentModelCatalogServiceDeps,
  agent: string
): Promise<{ fingerprint: string; accountHome: AgentSessionAccountHome } | null> {
  let accountHome: AgentSessionAccountHome
  try {
    accountHome = await deps.resolveAccountHome(agent)
  } catch {
    return null
  }
  return {
    fingerprint: agentModelCatalogFingerprint({ agent, accountHome, wslDistro: null }),
    accountHome
  }
}

/** A session launched with no model pick resolved its config scope's default; when that scope
 *  is the account's (a native workspace with no config of its own), it is the account's default. */
async function recordConfiguredDefault(
  deps: AgentModelCatalogServiceDeps,
  record: AgentSessionRecord,
  fingerprint: string,
  modelId: string
): Promise<void> {
  const accountHome = record.accountHome
  if (
    record.location.wslDistro !== null ||
    !isLegacyAgentSessionAccountHome(accountHome) ||
    !deps.recordWorkspacePath ||
    !deps.workspaceMayOverrideDefaultModel
  ) {
    return
  }
  const workspacePath = await deps.recordWorkspacePath(record)
  if (
    !workspacePath ||
    (await deps.workspaceMayOverrideDefaultModel({
      agent: record.provider,
      workspacePath,
      accountHomePath: accountHome.path
    }))
  ) {
    return
  }
  deps.store.recordConfiguredDefault(fingerprint, modelId)
}

async function runBounded<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<unknown>
): Promise<void> {
  const queue = [...items]
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await run(item).catch(() => {})
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker))
}

/**
 * Serves the host catalog to pickers, never through a session's serialize
 * queue. A session record names its own catalog (the account home pinned at
 * launch); without one, the key is the account a launch would pin right now —
 * never "whichever account listed last". `unknown` tells the client to keep
 * its static seed, and a missing or aged entry kicks one joined background
 * probe so the next read is warm. With no entry, the answer says that listing
 * is running, and only a read that asks waits for it. Failures suppress a new
 * probe for 30s, but never hide another listing already running for the account.
 */
export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  return {
    async read(params) {
      const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
      const scoped =
        record && record.provider === params.agent && deps.drivesRecord(record) ? record : undefined
      let fingerprint: string
      // The account a probe lists under; null where this host cannot spawn one natively.
      let probeHome: AgentSessionAccountHome | null
      if (scoped) {
        fingerprint = agentModelCatalogFingerprintForRecord(scoped)
        // Probes spawn natively; a WSL-pinned record has no host-side lister.
        probeHome = scoped.location.wslDistro === null ? scoped.accountHome : null
      } else {
        const key = await newChatCatalogKey(deps, params.agent)
        if (!key) {
          return { origin: 'unknown' }
        }
        fingerprint = key.fingerprint
        probeHome = key.accountHome
      }
      const accountHomePath =
        probeHome && isLegacyAgentSessionAccountHome(probeHome) ? probeHome.path : null
      let entry = deps.store.get(fingerprint)
      const probe = deps.probes?.[params.agent]
      const home = probeHome
      // Without an entry, answer from any running listing instead of starting a second one.
      let listing = !entry && home ? deps.store.pendingListing(fingerprint) : null
      if (probe && home) {
        if (entry && deps.store.shouldRefresh(fingerprint)) {
          void deps.store.refresh(fingerprint, params.agent, probe, () => probe(home))
        } else if (!entry && !listing && !deps.store.hasActiveFailure(fingerprint)) {
          void deps.store.refresh(fingerprint, params.agent, probe, () => probe(home))
          listing = deps.store.pendingListing(fingerprint)
        }
      }
      if (!entry) {
        if (!listing) {
          return { origin: 'unknown' }
        }
        if (!params.waitForListing) {
          return { origin: 'unknown', listingInProgress: true }
        }
        const listed = await listing
        entry = deps.store.get(fingerprint) ?? listed
        if (!entry) {
          return { origin: 'unknown' }
        }
      }
      return resultFromEntry(
        entry,
        await workspaceKeepsListedDefault(
          deps,
          params.agent,
          params.workspacePath,
          accountHomePath
        ),
        deps.listingNamesConfiguredModel?.has(params.agent) === true
      )
    },
    recordLiveListing(sessionId, listing) {
      const record = deps.getRecord(sessionId)
      if (!record || !deps.drivesRecord(record)) {
        return
      }
      // The record's pinned account and host: the account this child listed under.
      const fingerprint = agentModelCatalogFingerprintForRecord(record)
      const { configuredModelId, ...listed } = listing
      const saved = deps.store.recordSuccess(
        fingerprint,
        record.provider,
        { ...listed, fastModeTierByModel: new Map(), origin: 'live-session' },
        'live'
      )
      if (saved && configuredModelId) {
        void recordConfiguredDefault(deps, record, fingerprint, configuredModelId).catch(() => {})
      }
    },
    async prewarm() {
      const probes = deps.probes ?? {}
      await runBounded(Object.keys(probes), PREWARM_CONCURRENCY, async (agent) => {
        const probe = probes[agent]
        const key = probe ? await newChatCatalogKey(deps, agent) : null
        // A fresh entry, a listing already running, or a recent failure each mean nothing to do.
        if (!probe || !key || !deps.store.shouldRefresh(key.fingerprint)) {
          return
        }
        await deps.store.refresh(key.fingerprint, agent, probe, () => probe(key.accountHome))
      })
    }
  }
}
