import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { createCodexModelCatalogProbe } from '../../codex/codex-model-catalog-probe'
import { fetchCodexModelCatalogListing } from '../../codex/codex-structured-model-catalog'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  AgentModelCatalogUnavailableError,
  type AgentModelCatalogSessionAccess,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const MODEL = { model: 'gpt-live', displayName: 'Live model', isDefault: true }

function sessionRecord(agent: 'claude' | 'codex'): AgentSessionRecord {
  return {
    schemaVersion: 2,
    sessionId: 'live-session-1',
    provider: agent,
    accountHome: {
      variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: '/fixture/account'
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'fixture-folder',
      workspaceKind: 'folder'
    },
    providerHandleChain: [],
    lease: {
      sessionId: 'live-session-1',
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 0,
      lastRenewedAt: 0,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'fixture-key',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 1,
    updatedAt: 1
  }
}

function liveListing(): AgentModelCatalogSuccess {
  return {
    models: [{ id: MODEL.model, label: MODEL.displayName, isDefault: true, efforts: [] }],
    fastModeTierByModel: new Map(),
    origin: 'live-session'
  }
}

function codexFixture(account: unknown) {
  const store = new AgentModelCatalogStore({ now: () => 1000 })
  const record = sessionRecord('codex')
  const fingerprint = agentModelCatalogFingerprintForRecord(record)
  const requests = vi.fn(async (method: string) => {
    if (method === 'account/read') {
      if (account instanceof Error) {
        throw account
      }
      return account
    }
    if (method === 'thread/start') {
      return { thread: { id: 'fixture-thread' } }
    }
    if (method === 'model/list') {
      return { data: [MODEL], nextCursor: null }
    }
    return {}
  })
  const probe = createCodexModelCatalogProbe({
    resolveEnvironment: async () => ({}),
    resolveCommand: () => 'fixture-codex',
    resolveAccountKind: () => 'system',
    runSession: async (_invocation, body) => body({ request: requests, notify: () => {} })
  })
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => record,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/fixture/other-account' }),
    probes: { codex: probe }
  })
  const read = () =>
    service.read({ agent: 'codex', sessionId: record.sessionId, waitForListing: true })
  const access: AgentModelCatalogSessionAccess = {
    store,
    fingerprint,
    accountHomePath: record.accountHome.path
  }
  // The live session's own listing after start, as its background catalog refresh records it.
  const start = async () => {
    await requests('thread/start')
    const listing = await fetchCodexModelCatalogListing({ connection: { request: requests } })
    store.recordSuccess(fingerprint, 'codex', {
      models: listing.models,
      fastModeTierByModel: listing.fastModeTierByModel,
      origin: 'live-session'
    })
  }
  return { store, fingerprint, access, requests, read, start }
}

describe('availability beside a live model listing', () => {
  it('keeps Codex signed-out account/read evidence after thread/start succeeds', async () => {
    const fixture = codexFixture({ account: null, requiresOpenaiAuth: true })
    await fixture.read()
    await fixture.start()
    const result = await fixture.read()
    expect(result).toMatchObject({
      origin: 'live-session',
      models: [{ id: MODEL.model }],
      availability: { state: 'notSignedIn', account: 'system', recheckInMs: 30000 }
    })
    expect(
      fixture.requests.mock.calls.filter(([method]) => method === 'account/read')
    ).toHaveLength(1)
  })

  it("does not re-probe a healthy chat's fresh catalog", async () => {
    const fixture = codexFixture({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true })
    await fixture.start()
    await fixture.read()
    await fixture.read()
    expect(fixture.requests.mock.calls.some(([method]) => method === 'account/read')).toBe(false)
  })

  it.each([
    { account: { type: 'chatgpt' }, requiresOpenaiAuth: true },
    { account: null, requiresOpenaiAuth: false },
    new Error('account/read unsupported')
  ])('leaves a live Codex session enabled for signed-in or unknown status: %j', async (account) => {
    const fixture = codexFixture(account)
    await fixture.read()
    await fixture.start()
    expect((await fixture.read()).availability).toEqual({ state: 'ready' })
    expect(fixture.requests.mock.calls.some(([method]) => method === 'account/read')).toBe(true)
  })

  it.each(['claude', 'codex'] as const)(
    "the chat's own %s listings neither clear nor renew the probe's verdict",
    async (agent) => {
      let at = 1000
      const store = new AgentModelCatalogStore({ now: () => at })
      const record = sessionRecord(agent)
      const fingerprint = agentModelCatalogFingerprintForRecord(record)
      let signedIn = false
      const probe = vi.fn(async () => {
        if (!signedIn) {
          throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
        }
        return { ...liveListing(), origin: 'probe' as const }
      })
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => record,
        drivesRecord: () => true,
        resolveAccountHome: async () => record.accountHome,
        probes: { [agent]: probe }
      })
      const params = { agent, sessionId: record.sessionId, waitForListing: true }
      await service.read(params)
      at += 10000
      const live: AgentModelCatalogSessionAccess = {
        store,
        fingerprint,
        accountHomePath: record.accountHome.path
      }
      store.recordSuccess(fingerprint, agent, liveListing())
      await store.refresh(fingerprint, agent, live, async () => liveListing())
      await store.refresh(fingerprint, agent, live, async () => {
        throw new Error('model/list timeout')
      })
      expect((await service.read(params)).availability).toMatchObject({ recheckInMs: 20000 })
      expect(probe).toHaveBeenCalledTimes(1)
      at += 20000
      expect(store.statuses.needsProbe(fingerprint)).toBe(true)
      signedIn = true
      // The aged verdict stands while its re-probe runs; the probe's answer then clears it.
      await service.read(params)
      expect(
        (await service.read({ agent, sessionId: record.sessionId, waitForAvailability: true }))
          .availability
      ).toEqual({ state: 'ready' })
      expect(probe).toHaveBeenCalledTimes(2)
    }
  )
})
