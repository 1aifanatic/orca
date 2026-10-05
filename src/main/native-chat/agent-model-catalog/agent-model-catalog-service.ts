import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { StructuredAgentCommandInvocation } from '../../../shared/tui-agent-launch-command-override'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import type {
  AgentModelCatalogSessionAccess,
  AgentModelCatalogEntry,
  AgentModelCatalogProbe,
  AgentModelCatalogStore
} from './agent-model-catalog-store'

export type AgentModelCatalogServiceDeps = {
  store: AgentModelCatalogStore
  getRecord: (sessionId: string) => AgentSessionRecord | undefined
  /** The account home a structured launch for this agent would pin right now —
   *  the SAME resolver the create path fills `record.accountHome` with, so a
   *  record-less read can never answer from another account's listing. */
  resolveAccountHome: (
    agent: 'claude' | 'codex'
  ) => Promise<{ variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'; path: string }>
  readSessionCatalogAccess?: (
    agent: 'claude' | 'codex',
    sessionId: string
  ) => AgentModelCatalogSessionAccess | undefined
  resolveWorkspacePath?: (workspaceId: string) => Promise<string>
  prepareProbe?: (
    agent: 'claude' | 'codex',
    cwd?: string,
    invocation?: StructuredAgentCommandInvocation
  ) => Promise<{ invocation: StructuredAgentCommandInvocation; probe: AgentModelCatalogProbe }>
  /** Session-less listers, one per agent that has one on this host. */
  probes?: Partial<Record<'claude' | 'codex', AgentModelCatalogProbe>>
  /** Whether the workspace's own config could pick a model other than the listed default. */
  workspaceMayOverrideDefaultModel?: (input: {
    agent: 'claude' | 'codex'
    workspacePath: string
    accountHomePath: string
  }) => Promise<boolean>
}

export type AgentModelCatalogService = {
  read: (params: {
    agent: 'claude' | 'codex'
    sessionId?: string
    /** Where a new chat would run; null when one was named but is not a local directory. */
    workspacePath?: string | null
    /** With no entry yet, answer from the listing this read starts or joins instead of `unknown`. */
    waitForListing?: boolean
  }) => Promise<AgentSessionModelCatalogResult>
}

function resultFromEntry(
  entry: AgentModelCatalogEntry,
  namesDefault: boolean
): AgentSessionModelCatalogResult {
  return {
    origin: entry.origin,
    // Without a default the picker names nothing until the chat reports its model.
    models: entry.models.map((model) =>
      namesDefault ? { ...model } : { ...model, isDefault: false }
    ),
    ...(entry.fastModeSupport ? { fastModeSupport: entry.fastModeSupport } : {}),
    fetchedAt: entry.fetchedAt
  }
}

/** A named workspace keeps the listed default only when none of its own config can replace it. */
async function workspaceKeepsListedDefault(
  deps: AgentModelCatalogServiceDeps,
  agent: 'claude' | 'codex',
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

/**
 * Serves the host catalog to pickers, never through a session's serialize
 * queue. A session record names its own catalog (the account home pinned at
 * launch); without one, the key is the account a launch would pin right now —
 * never "whichever account listed last". `unknown` tells the client to keep
 * its static seed, and a missing or aged entry kicks one joined background
 * probe so the next read is warm. With no entry, the answer says that listing
 * is running, and only a read that asks waits for it. Failures are the store's
 * 30s TTL, never an answer: inside it a read answers `unknown` at once.
 */
export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  return {
    async read(params) {
      const record = params.sessionId ? deps.getRecord(params.sessionId) : undefined
      const scoped = record && record.provider === params.agent ? record : undefined
      let fingerprint: string
      let accountHomePath: string | null
      if (scoped) {
        fingerprint = agentModelCatalogFingerprintForRecord(scoped)
        // Probes spawn natively; a WSL-pinned record has no host-side lister.
        accountHomePath = scoped.location.wslDistro === null ? scoped.accountHome.path : null
      } else {
        let resolved: { variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'; path: string }
        try {
          resolved = await deps.resolveAccountHome(params.agent)
        } catch {
          return { origin: 'unknown' }
        }
        fingerprint = agentModelCatalogFingerprint({
          agent: params.agent,
          accountHomeVariable: resolved.variable,
          accountHomePath: resolved.path,
          wslDistro: null
        })
        accountHomePath = resolved.path
      }
      const active =
        scoped && params.sessionId
          ? deps.readSessionCatalogAccess?.(params.agent, params.sessionId)
          : undefined
      let probe = deps.probes?.[params.agent]
      if (deps.prepareProbe && accountHomePath) {
        try {
          const cwd =
            active?.invocation?.cwd ??
            (scoped && deps.resolveWorkspacePath
              ? await deps.resolveWorkspacePath(scoped.location.workspaceId)
              : (params.workspacePath ?? undefined))
          const prepared = await deps.prepareProbe(params.agent, cwd, active?.invocation)
          fingerprint =
            active?.fingerprint ??
            agentModelCatalogFingerprint({
              agent: params.agent,
              accountHomeVariable:
                scoped?.accountHome.variable ??
                (params.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'),
              accountHomePath,
              wslDistro: scoped?.location.wslDistro ?? null,
              invocation: prepared.invocation
            })
          probe = prepared.probe
        } catch {
          const cached = active && deps.store.get(active.fingerprint)
          return cached
            ? resultFromEntry(
                cached,
                await workspaceKeepsListedDefault(
                  deps,
                  params.agent,
                  params.workspacePath,
                  accountHomePath
                )
              )
            : { origin: 'unknown' }
        }
      }
      let entry = deps.store.get(fingerprint)
      const home = accountHomePath
      // Without an entry, join a running listing too: that is the one a waiting read answers from.
      const selectedProbe = probe
      const listing =
        selectedProbe &&
        home &&
        (entry ? deps.store.shouldRefresh(fingerprint) : !deps.store.hasActiveFailure(fingerprint))
          ? deps.store.refresh(fingerprint, params.agent, () => selectedProbe(home))
          : null
      if (!entry) {
        if (!listing) {
          return { origin: 'unknown' }
        }
        if (!params.waitForListing) {
          return { origin: 'unknown', listingInProgress: true }
        }
        entry = await listing
        if (!entry) {
          return { origin: 'unknown' }
        }
      }
      return resultFromEntry(
        entry,
        await workspaceKeepsListedDefault(deps, params.agent, params.workspacePath, accountHomePath)
      )
    }
  }
}
