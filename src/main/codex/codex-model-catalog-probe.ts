import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from './codex-app-server-session'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredLaunchResolverDeps
} from './codex-structured-launch-resolution'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

export type CodexModelCatalogProbeDeps = Pick<
  CodexStructuredLaunchResolverDeps,
  'resolveCommand' | 'resolveEnvironment'
> & {
  /** Test seam; production runs the shared short-lived app-server session. */
  runSession?: typeof runCodexAppServerSession
}

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

/**
 * Lists models without a live session: one short-lived read-only app-server under the given
 * account home and the shared probe budget, spawned through the SAME invocation resolver a
 * structured session launch uses — a probe that resolved a different binary or env could list
 * models the user's sessions cannot see, under their key. Its supervised session runner is the
 * one every Codex app-server RPC consumer shares.
 */
export function createCodexModelCatalogProbe(
  deps: CodexModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHome): Promise<AgentModelCatalogSuccess> => {
    const accountHomePath = requireLegacyAgentSessionAccountHome(accountHome).path
    const { command, environment } = await resolveCodexStructuredInvocation(deps)
    const run = deps.runSession ?? runCodexAppServerSession
    const listing = await run(
      {
        command,
        args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
        cliPath: command,
        env: { ...definedEnv(environment), CODEX_HOME: accountHomePath },
        timeoutMs: AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS
      },
      (rpc) => fetchCodexModelCatalogListing({ connection: rpc })
    )
    if (listing.models.length === 0) {
      throw new Error('codex app-server listed no models')
    }
    return {
      models: listing.models,
      fastModeTierByModel: listing.fastModeTierByModel,
      origin: 'probe'
    }
  }
}
