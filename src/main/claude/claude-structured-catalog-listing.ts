// What a Claude child's listing says about its account, apart from this session's own state.

import type {
  AgentSessionFastModeSupport,
  AgentSessionOptionsResult
} from '../../shared/agent-session-wire'
import type { AgentModelCatalogLiveListing } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { ListedModel } from './claude-structured-model-catalog'
import type { ClaudeSession } from './claude-structured-session-state'

const TRANSIENT_FAST_MODE_REASONS = new Set(['network_error', 'unknown', 'pending'])
const NON_BLOCKING_FAST_MODE_REASONS = new Set(['preference', 'sdk_opt_in_required'])

export function claudeFastModeSupport(
  models: readonly ListedModel[],
  disabledReason: string | undefined
): AgentSessionFastModeSupport | undefined {
  if (disabledReason && TRANSIENT_FAST_MODE_REASONS.has(disabledReason)) {
    return undefined
  }
  if (disabledReason && !NON_BLOCKING_FAST_MODE_REASONS.has(disabledReason)) {
    return { supported: false, reason: disabledReason }
  }
  if (!models.some((model) => model.supportsFastMode === true)) {
    return models.length > 0 && models.every((model) => model.supportsFastMode === false)
      ? { supported: false, reason: 'model-not-supported' }
      : undefined
  }
  return { supported: true }
}

export type WireClaudeModel = AgentSessionOptionsResult['models'][number]

function wireClaudeModel(entry: ListedModel): WireClaudeModel {
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
    isDefault: entry.isDefault,
    efforts: entry.efforts,
    ...(entry.supportsFastMode !== undefined ? { supportsFastMode: entry.supportsFastMode } : {})
  }
}

export function wireClaudeModels(models: readonly ListedModel[]): WireClaudeModel[] {
  return models.map(wireClaudeModel)
}

/** The listing, with what the CLI runs when no effort is sent on each model the child applies —
 *  a default only a running child knows, and only while this session has no effort pick. */
function catalogClaudeModels(session: ClaudeSession, discovered: ListedModel[]): WireClaudeModel[] {
  const applied = session.options.has('effort') ? undefined : session.appliedOptions
  return discovered.map((listed) => {
    const model = wireClaudeModel(listed)
    const effort = applied?.effort
    const runsApplied =
      applied?.model !== undefined &&
      (listed.id === applied.model || listed.resolvedModel === applied.model)
    return effort && runsApplied && model.efforts.some((choice) => choice.value === effort)
      ? { ...model, defaultEffort: effort }
      : model
  })
}

/** The account-level facts of a provider listing, for the host to save: this session's disabled
 *  reason and its unlisted current model stay out, so another surface never inherits session state
 *  as a catalog. A child launched with `--model X` lists X itself (Claude Code 2.1.280 adds a row
 *  named by the raw id, "Custom model"), whether or not X exists; native rows carry a display name
 *  of their own, so a row named by its id is the launch talking, not the account. */
export function claudeCatalogListing(
  session: ClaudeSession,
  discovered: ListedModel[]
): AgentModelCatalogLiveListing | undefined {
  if (discovered.length === 0) {
    return undefined
  }
  const launched = session.launchedModel
  const launchOnly =
    launched !== null && discovered.some((row) => row.id === launched && row.label === row.id)
  const support = claudeFastModeSupport(discovered, undefined)
  return {
    models: catalogClaudeModels(session, discovered),
    ...(support ? { fastModeSupport: support } : {}),
    ...(launchOnly ? { launchOnlyModelId: launched } : {})
  }
}
