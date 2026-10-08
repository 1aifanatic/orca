import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { describe, expect, it, vi } from 'vitest'

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogSessionAccess
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const spans = vi.hoisted(() => ({
  started: [] as { name: string; attributes: Record<string, unknown>; outcome: string }[]
}))

vi.mock('../../observability/tracer', () => ({
  startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => {
    const span = { name, attributes: { ...options?.attributes }, outcome: 'open' }
    spans.started.push(span)
    return {
      setAttribute: (key: string, value: unknown) => {
        span.attributes[key] = value
      },
      end: () => {
        span.outcome = 'ok'
      },
      fail: () => {
        span.outcome = 'failed'
      }
    }
  }
}))
function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    fastModeTierByModel: new Map(),
    origin: 'probe'
  }
}

const HOME = (variable: string, path: string): AgentSessionAccountHome => ({ variable, path })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('model catalog prewarm', () => {
  it('lists every agent once for the account a new chat would pin, and joins a read meanwhile', async () => {
    let now = 0
    const store = new AgentModelCatalogStore({ now: () => now })
    const codexListed = deferred<AgentModelCatalogSuccess>()
    const codex = vi.fn(async (_home: AgentSessionAccountHome) => codexListed.promise)
    const grok = vi.fn(async (_home: AgentSessionAccountHome) => listing('grok-4'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async (agent) =>
        agent === 'codex' ? HOME('CODEX_HOME', '/homes/a') : HOME('GROK_HOME', '/grok'),
      probes: { codex, grok }
    })

    const prewarmed = service.prewarm()
    await vi.waitFor(() => expect(codex).toHaveBeenCalledTimes(1))
    // A picker opening while the prewarm lists joins it instead of spawning a second listing.
    expect(await service.read({ agent: 'codex' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    codexListed.resolve(listing('gpt-a'))
    await prewarmed

    expect(codex).toHaveBeenCalledTimes(1)
    expect(codex).toHaveBeenCalledWith(HOME('CODEX_HOME', '/homes/a'))
    expect(grok).toHaveBeenCalledTimes(1)
    expect((await service.read({ agent: 'codex' })).origin).toBe('probe')
    expect((await service.read({ agent: 'grok' })).origin).toBe('probe')

    // Fresh: a second prewarm lists nothing; once old, it lists again.
    await service.prewarm()
    expect(codex).toHaveBeenCalledTimes(1)
    now += AGENT_MODEL_CATALOG_FRESH_MS
    await service.prewarm()
    expect(codex).toHaveBeenCalledTimes(2)
    expect(grok).toHaveBeenCalledTimes(2)
  })

  it('lists the new account after a switch and leaves the old account’s catalog alone', async () => {
    const store = new AgentModelCatalogStore()
    let selected = '/homes/a'
    const probe = vi.fn(async (home: AgentSessionAccountHome) =>
      listing('variable' in home && home.path === '/homes/a' ? 'gpt-a' : 'gpt-b')
    )
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => HOME('CODEX_HOME', selected),
      probes: { codex: probe }
    })
    await service.prewarm()
    selected = '/homes/b'
    await service.prewarm()

    expect(probe.mock.calls.map(([home]) => home)).toEqual([
      HOME('CODEX_HOME', '/homes/a'),
      HOME('CODEX_HOME', '/homes/b')
    ])
    const read = await service.read({ agent: 'codex' })
    expect(read.origin !== 'unknown' && read.models.map((model) => model.id)).toEqual(['gpt-b'])
  })

  it('respects the failure back-off and skips an agent whose account cannot be resolved', async () => {
    const store = new AgentModelCatalogStore()
    const codex = vi.fn(
      async (_home: AgentSessionAccountHome): Promise<AgentModelCatalogSuccess> => {
        throw new Error('spawn codex ENOENT')
      }
    )
    const claude = vi.fn(async (_home: AgentSessionAccountHome) => listing('opus'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async (agent) => {
        if (agent === 'claude') {
          throw new Error('account home unreadable')
        }
        return HOME('CODEX_HOME', '/homes/a')
      },
      probes: { codex, claude }
    })
    spans.started.length = 0
    await service.prewarm()
    await service.prewarm()
    expect(codex).toHaveBeenCalledTimes(1)
    expect(claude).not.toHaveBeenCalled()
    // Each listing leaves its agent and outcome in the trace log; the span carries its duration.
    expect(spans.started).toEqual([
      {
        name: 'agentModelCatalog.discovery',
        attributes: { agent: 'codex', lister: 'probe' },
        outcome: 'failed'
      }
    ])
  })

  it('runs at most two listings at once', async () => {
    const store = new AgentModelCatalogStore()
    let running = 0
    let peak = 0
    const gates = new Map<string, () => void>()
    const probeFor = (agent: string) => async (): Promise<AgentModelCatalogSuccess> => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise<void>((resolve) => gates.set(agent, resolve))
      running -= 1
      return listing(`${agent}-model`)
    }
    const agents = ['codex', 'claude', 'grok', 'opencode', 'pi']
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async (agent) => HOME('HOME', `/homes/${agent}`),
      probes: Object.fromEntries(agents.map((agent) => [agent, probeFor(agent)]))
    })
    const prewarmed = service.prewarm()
    for (const agent of agents) {
      await vi.waitFor(() => expect(gates.has(agent)).toBe(true))
      gates.get(agent)?.()
    }
    await prewarmed
    expect(peak).toBe(2)
  })
})

describe('one account, one catalog key', () => {
  function record(path: string): AgentSessionRecord {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the key reads only provider, accountHome and location.
    return {
      sessionId: 'session-1',
      provider: 'codex',
      accountHome: HOME('CODEX_HOME', path),
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'ws-1',
        workspaceKind: 'git-worktree'
      }
    } as AgentSessionRecord
  }

  it('a new chat’s read, the session it launches and that session’s own saves share one key', async () => {
    const store = new AgentModelCatalogStore()
    const managedHome = '/orca/codex-accounts/acct-1/home'
    const launched = record(managedHome)
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => launched,
      drivesRecord: () => true,
      // The read-only resolver and launch preparation both answer the account's persisted path.
      resolveAccountHome: async () => HOME('CODEX_HOME', managedHome)
    })
    // What the chat saved, through the host and through the Codex adapter's own handle…
    service.recordLiveListing('session-1', { models: listing('gpt-live').models })
    const adapterAccess = agentModelCatalogSessionAccess(
      store,
      { agent: 'codex', accountHomeVariable: 'CODEX_HOME' },
      managedHome
    )
    expect(adapterAccess?.fingerprint).toBe(agentModelCatalogFingerprintForRecord(launched))

    // …is what the next new chat reads, with no record to go on: no cold start for this account.
    const read = await service.read({ agent: 'codex' })
    expect(read.origin !== 'unknown' && read.models.map((model) => model.id)).toEqual(['gpt-live'])
  })
})
