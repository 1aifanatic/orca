import type { CodexOpenedThread } from './codex-structured-thread-open'
import type {
  CodexSessionCatalogAccess,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredLaunch
} from './codex-structured-session-state'
import { codexAcquireCatalogListing } from './codex-structured-session-options'
import {
  composeCodexSessionOptionCatalog,
  type CodexSessionOptionCatalog
} from './codex-structured-model-catalog'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import { providerExecutableMissing } from '../provider-process/provider-executable-missing'

export function codexAcquireCatalogAccess(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'modelCatalog'>,
  launch: Pick<CodexStructuredLaunch, 'codexHome'>
): CodexSessionCatalogAccess | undefined {
  return agentModelCatalogSessionAccess(deps.modelCatalog, CODEX_STRUCTURED_AGENT, launch.codexHome)
}

/** A spawn that found no Codex CLI is that home's verdict, as the catalog probe would type it. */
export function recordCodexMissingCli(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'modelCatalog'>,
  launch: Pick<CodexStructuredLaunch, 'codexHome'>,
  error: unknown
): void {
  const access = providerExecutableMissing(error) ? codexAcquireCatalogAccess(deps, launch) : null
  access?.store.failures.recordStartRefusal(access.fingerprint, 'codex', { reason: 'cliMissing' })
}

/** Use saved catalog knowledge for Fast restore without waiting on discovery. */
export function codexAcquireFastModeCatalog(input: {
  catalogAccess: CodexSessionCatalogAccess | undefined
  opened: Pick<CodexOpenedThread, 'model' | 'effort'>
  restoreNeedsCatalog: boolean
}): CodexSessionOptionCatalog | null {
  if (!input.restoreNeedsCatalog) {
    return null
  }
  const listing = codexAcquireCatalogListing(input.catalogAccess)
  if (!listing) {
    return null
  }
  try {
    return composeCodexSessionOptionCatalog(listing, {
      current: {
        ...(input.opened.model ? { model: input.opened.model } : {}),
        ...(input.opened.effort ? { effort: input.opened.effort } : {}),
        fastMode: true
      }
    })
  } catch {
    return null
  }
}
