import { CODEX_SHORT_LIVED_PROBE_CONFIG_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import { runCodexAppServerSession } from './codex-app-server-session'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredLaunchResolverDeps
} from './codex-structured-launch-resolution'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

// Why 15s: the whole probe session is stopped at the deadline (on POSIX its supervisor then gets
// up to PROVIDER_SUPERVISOR_MAX_STOP_MS), and a cold `model/list` may pay one /models fetch.
const CODEX_MODEL_CATALOG_PROBE_TIMEOUT_MS = 15_000

export type CodexModelCatalogProbeDeps = Pick<
  CodexStructuredLaunchResolverDeps,
  'resolveCommand' | 'resolveEnvironment' | 'resolveLaunchArgs'
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
 * Lists models without a live session: one short-lived app-server
 * under the given account home, spawned through the SAME invocation resolver
 * and saved Arguments a structured session launch uses — a probe that resolved
 * a different binary, env or config could list models the user's sessions
 * cannot see, under their key.
 */
export function createCodexModelCatalogProbe(
  deps: CodexModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHomePath: string): Promise<AgentModelCatalogSuccess> => {
    const { command, environment } = await resolveCodexStructuredInvocation(deps)
    const args = codexStructuredLaunchArgs(await deps.resolveLaunchArgs())
    const run = deps.runSession ?? runCodexAppServerSession
    const listing = await run(
      {
        command,
        // The probe's own config comes after the Arguments' `-c`, which Codex applies in order. Codex
        // folds `--enable`/`--disable` in after every `-c`, disables last, so only `--disable`
        // outranks a saved `--enable plugins`.
        args: [
          'app-server',
          ...args,
          ...CODEX_SHORT_LIVED_PROBE_CONFIG_ARGS,
          '--disable',
          'plugins'
        ],
        cliPath: command,
        env: { ...definedEnv(environment), CODEX_HOME: accountHomePath },
        timeoutMs: CODEX_MODEL_CATALOG_PROBE_TIMEOUT_MS
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
