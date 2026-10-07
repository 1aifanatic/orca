import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { isMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { getSystemCodexHomePath } from './codex-home-paths'
import { join, resolve } from 'node:path'
import { readStoredCodexCredentialState } from '../codex-accounts/managed-codex-auth-readiness'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
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
  'resolveCommand' | 'resolveEnvironment'
> & {
  resolveAccountKind?: (home: string) => AgentSessionAccountKind | undefined
  /** The sync a launch runs on this home first, so the probe reads the login a launch would. */
  prepareHome?: (home: string) => void
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

/** Codex answers "no account" for a missing auth.json and for one caught mid-write (it truncates
 *  and rewrites in place). Only no file, or a settled file with no credential, is signed out. */
function storedLoginIsAbsent(home: string): boolean {
  const state = readStoredCodexCredentialState(join(home, 'auth.json'))
  return state === 'missing' || state === 'no-credential'
}

/**
 * Lists models without a live session: one short-lived read-only app-server
 * under the given account home, spawned through the SAME invocation resolver
 * a structured session launch uses — a probe that resolved a different binary
 * or env could list models the user's sessions cannot see, under their key.
 */
export function createCodexModelCatalogProbe(
  deps: CodexModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHomePath: string): Promise<AgentModelCatalogSuccess> => {
    const { command, environment } = await resolveCodexStructuredInvocation(deps)
    deps.prepareHome?.(accountHomePath)
    const run = deps.runSession ?? runCodexAppServerSession
    const listing = await run(
      {
        command,
        args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
        cliPath: command,
        env: { ...definedEnv(environment), CODEX_HOME: accountHomePath },
        timeoutMs: CODEX_MODEL_CATALOG_PROBE_TIMEOUT_MS
      },
      async (rpc) => {
        // Both at once, so the account check adds no latency; its signed-out verdict still wins.
        const listed = fetchCodexModelCatalogListing({ connection: rpc })
        void listed.catch(() => {})
        const response: unknown = await rpc
          .request('account/read', { refreshToken: false }, { timeoutMs: 2_000 })
          // Unknown account status cannot block sending.
          .catch(() => undefined)
        if (
          typeof response === 'object' &&
          response !== null &&
          !Array.isArray(response) &&
          'requiresOpenaiAuth' in response &&
          response.requiresOpenaiAuth === true &&
          'account' in response &&
          response.account === null &&
          storedLoginIsAbsent(accountHomePath)
        ) {
          const account = deps.resolveAccountKind
            ? deps.resolveAccountKind(accountHomePath)
            : resolve(accountHomePath) === resolve(getSystemCodexHomePath())
              ? 'system'
              : undefined
          throw new AgentModelCatalogUnavailableError({
            reason: 'notSignedIn',
            ...(account ? { account } : {})
          })
        }
        return listed
      }
    ).catch((error: unknown) => {
      if (isMissingProviderExecutable(error, command)) {
        throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
      }
      throw error
    })
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
