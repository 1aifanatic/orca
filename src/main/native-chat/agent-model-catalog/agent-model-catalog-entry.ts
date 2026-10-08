import type {
  AgentSessionFastModeSupport,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'

/** One listing as the store keeps it. */
export type AgentModelCatalogListing = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  /** Provider-advertised Fast tier per model id. */
  fastModeTierByModel: Record<string, string>
  origin: 'live-session' | 'probe'
  at: number
}

/** What a running session listed, as its adapter hands it to the host. Kept here, apart from the
 *  store, so the session wire types don't pull the store's Node-only persistence into clients. */
export type AgentModelCatalogLiveListing = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  /** A row only this session's launch added (its own `--model`): kept only once the account's
   *  catalog already lists that model. */
  launchOnlyModelId?: string
}

/** A live options answer whose model rows are the account's listing as the child reported it. */
export function withLiveCatalogListing<
  T extends Pick<AgentModelCatalogLiveListing, 'models' | 'fastModeSupport'>
>(options: T): T & { catalogListing: AgentModelCatalogLiveListing } {
  return {
    ...options,
    catalogListing: {
      models: options.models,
      ...(options.fastModeSupport ? { fastModeSupport: options.fastModeSupport } : {})
    }
  }
}

export type AgentModelCatalogEntry = {
  agent: string
  fingerprint: string
  discovered: AgentModelCatalogListing | null
  live: AgentModelCatalogListing | null
  // The merged view every reader uses, derived from the two listings above.
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  fastModeTierByModel: Record<string, string>
  origin: 'live-session' | 'probe'
  fetchedAt: number
}

/** Which models exist and their menus follow the newer listing; the configured default and
 *  default efforts are discovery's, else what a live child reported while its model offers it. */
function mergedModels(
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null
): AgentSessionModelOption[] {
  const liveIsNewer = live !== null && (discovered === null || live.at >= discovered.at)
  const newer = liveIsNewer ? live : discovered
  const older = liveIsNewer ? discovered : live
  return (newer?.models ?? []).map((model) => {
    const listed = discovered?.models.find((entry) => entry.id === model.id)
    const reported = live?.models.find((entry) => entry.id === model.id)
    const efforts =
      model.efforts.length > 0
        ? model.efforts
        : (older?.models.find((entry) => entry.id === model.id)?.efforts ?? [])
    const defaultEffort = [listed?.defaultEffort, reported?.defaultEffort].find(
      (effort) => effort !== undefined && efforts.some((choice) => choice.value === effort)
    )
    const { defaultEffort: _own, ...rest } = model
    return {
      ...rest,
      // A session names no default; without any discovery its own flags are all there is.
      isDefault: discovered ? listed?.isDefault === true : model.isDefault,
      efforts,
      ...(defaultEffort ? { defaultEffort } : {})
    }
  })
}

export function agentModelCatalogEntry(
  agent: string,
  fingerprint: string,
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null
): AgentModelCatalogEntry | null {
  const newer = live && (!discovered || live.at >= discovered.at) ? live : discovered
  if (!newer) {
    return null
  }
  const older = newer === live ? discovered : live
  const fastModeSupport = newer.fastModeSupport ?? older?.fastModeSupport
  return {
    agent,
    fingerprint,
    discovered,
    live,
    models: mergedModels(discovered, live),
    ...(fastModeSupport ? { fastModeSupport } : {}),
    fastModeTierByModel: {
      ...live?.fastModeTierByModel,
      ...discovered?.fastModeTierByModel
    },
    origin: newer.origin,
    fetchedAt: newer.at
  }
}
