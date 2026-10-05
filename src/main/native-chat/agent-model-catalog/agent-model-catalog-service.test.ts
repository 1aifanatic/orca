import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogSessionAccess
} from './agent-model-catalog-fingerprint'
import {
  createAgentModelCatalogService,
  type AgentModelCatalogServiceDeps
} from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

function record(accountHomePath: string): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only provider, accountHome and location; the rest of the record is irrelevant here.
  return {
    sessionId: 'session-1',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: accountHomePath },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws-1',
      workspaceKind: 'git-worktree'
    }
  } as AgentSessionRecord
}

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    fastModeTierByModel: new Map(),
    origin: 'probe'
  }
}

function selectedHomeFingerprint(path: string): string {
  return agentModelCatalogFingerprint({
    agent: 'codex',
    accountHomeVariable: 'CODEX_HOME',
    accountHomePath: path,
    wslDistro: null
  })
}

const CODEX_HOME = (path: string): { variable: 'CODEX_HOME'; path: string } => ({
  variable: 'CODEX_HOME',
  path
})

describe('agent model catalog service', () => {
  it('answers unknown and kicks one probe for a session whose key has never listed', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async (_home: string) => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record('/homes/a'),
      resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    // A second read while the probe is in flight must not start another, and a
    // record-scoped read probes the RECORD's pinned home, not the selection.
    await service.read({ agent: 'codex', sessionId: 'session-1' })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith('/homes/a')
    await vi.waitFor(async () => {
      const result = await service.read({ agent: 'codex', sessionId: 'session-1' })
      expect(result.origin).toBe('probe')
    })
  })

  it('an account switch with no record reads and prewarms the NEW account, never the old entry', async () => {
    const store = new AgentModelCatalogStore()
    // The old account listed under its own fingerprint before the switch.
    const oldFingerprint = selectedHomeFingerprint('/homes/old')
    store.recordSuccess(oldFingerprint, 'codex', listing('gpt-old'))
    const probe = vi.fn(async () => listing('gpt-new'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => CODEX_HOME('/homes/new'),
      probes: { codex: probe }
    })
    // The record-less read follows the CURRENT selection: unknown, never gpt-old.
    expect(await service.read({ agent: 'codex' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    expect(probe).toHaveBeenCalledWith('/homes/new')
    await vi.waitFor(async () => {
      const result = await service.read({ agent: 'codex' })
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-new')
    })
    // The new listing landed under the new selection's key; the old entry is untouched.
    expect(store.get(selectedHomeFingerprint('/homes/new'))!.models[0]!.id).toBe('gpt-new')
    expect(store.get(oldFingerprint)!.models[0]!.id).toBe('gpt-old')
  })

  it('a record-less read serves the selected account entry when it exists', async () => {
    const store = new AgentModelCatalogStore()
    store.recordSuccess(selectedHomeFingerprint('/homes/selected'), 'codex', listing('gpt-mine'))
    store.recordSuccess(selectedHomeFingerprint('/homes/other'), 'codex', listing('gpt-other'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => CODEX_HOME('/homes/selected')
    })
    const result = await service.read({ agent: 'codex' })
    expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-mine')
  })

  it('a session record outranks the current selection for its own reads', async () => {
    const store = new AgentModelCatalogStore()
    const sessionRecord = record('/homes/session')
    store.recordSuccess(
      agentModelCatalogFingerprintForRecord(sessionRecord),
      'codex',
      listing('gpt-session')
    )
    store.recordSuccess(
      selectedHomeFingerprint('/homes/selected'),
      'codex',
      listing('gpt-selected')
    )
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => sessionRecord,
      resolveAccountHome: async () => CODEX_HOME('/homes/selected')
    })
    const result = await service.read({ agent: 'codex', sessionId: 'session-1' })
    expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-session')
  })

  it('a probe failure is a TTL-bounded fact, never an answer', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async () => {
      throw new Error('spawn failed')
    })
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record('/homes/a'),
      resolveAccountHome: async () => CODEX_HOME('/homes/a'),
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    // Still a clean unknown — and the failure TTL suppresses a probe storm.
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toEqual({
      origin: 'unknown'
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('a failed account-home resolution answers unknown without probing', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async () => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => {
        throw new Error('no store yet')
      },
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex' })).toEqual({ origin: 'unknown' })
    expect(probe).not.toHaveBeenCalled()
  })

  describe('a read that waits for the first listing', () => {
    function deferredListing() {
      let resolve!: (success: AgentModelCatalogSuccess) => void
      let reject!: (error: Error) => void
      const promise = new Promise<AgentModelCatalogSuccess>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    function coldService(probe: (home: string) => Promise<AgentModelCatalogSuccess>) {
      const store = new AgentModelCatalogStore()
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
        probes: { codex: probe }
      })
      return { store, service }
    }

    it('joins the listing the first read started and answers with it', async () => {
      const pending = deferredListing()
      const probe = vi.fn(() => pending.promise)
      const { service } = coldService(probe)
      expect(await service.read({ agent: 'codex' })).toEqual({
        origin: 'unknown',
        listingInProgress: true
      })
      const waited = service.read({ agent: 'codex', waitForListing: true })
      pending.resolve(listing('gpt-listed'))
      const result = await waited
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-listed')
      expect(probe).toHaveBeenCalledTimes(1)
    })

    it('answers a plain unknown when the listing fails', async () => {
      const pending = deferredListing()
      const { service } = coldService(() => pending.promise)
      const waited = service.read({ agent: 'codex', waitForListing: true })
      pending.reject(new Error('spawn failed'))
      expect(await waited).toEqual({ origin: 'unknown' })
    })

    it('does not wait or report a listing while a failure is inside its TTL', async () => {
      const probe = vi.fn(async (): Promise<AgentModelCatalogSuccess> => {
        throw new Error('spawn failed')
      })
      const { store, service } = coldService(probe)
      store.recordFailure(selectedHomeFingerprint('/homes/selected'), 'spawn failed')
      expect(await service.read({ agent: 'codex', waitForListing: true })).toEqual({
        origin: 'unknown'
      })
      expect(await service.read({ agent: 'codex' })).toEqual({ origin: 'unknown' })
      expect(probe).not.toHaveBeenCalled()
    })

    it('reports no listing where the host has no lister for the account', async () => {
      const store = new AgentModelCatalogStore()
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        resolveAccountHome: async () => CODEX_HOME('/homes/selected')
      })
      expect(await service.read({ agent: 'codex', waitForListing: true })).toEqual({
        origin: 'unknown'
      })
    })

    it('serves an aged entry at once and refreshes it behind the answer', async () => {
      let now = 0
      const store = new AgentModelCatalogStore({ now: () => now })
      store.recordSuccess(selectedHomeFingerprint('/homes/selected'), 'codex', listing('gpt-old'))
      now = AGENT_MODEL_CATALOG_FRESH_MS
      const probe = vi.fn(() => new Promise<AgentModelCatalogSuccess>(() => {}))
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
        probes: { codex: probe }
      })
      const result = await service.read({ agent: 'codex', waitForListing: true })
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-old')
      expect(probe).toHaveBeenCalledTimes(1)
    })
  })

  describe('a read for the workspace a new chat runs in', () => {
    function serviceWith(mayOverride: boolean) {
      const store = new AgentModelCatalogStore()
      store.recordSuccess(selectedHomeFingerprint('/homes/selected'), 'codex', listing('gpt-user'))
      const workspaceMayOverrideDefaultModel = vi.fn(async () => mayOverride)
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
        workspaceMayOverrideDefaultModel
      })
      return { service, workspaceMayOverrideDefaultModel }
    }

    function defaults(
      result: Awaited<ReturnType<ReturnType<typeof serviceWith>['service']['read']>>
    ) {
      return result.origin === 'unknown' ? null : result.models.map((model) => model.isDefault)
    }

    it('names no default when the workspace config could pick another model', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(true)
      const result = await service.read({ agent: 'codex', workspacePath: '/repo/wt' })
      expect(defaults(result)).toEqual([false])
      expect(workspaceMayOverrideDefaultModel).toHaveBeenCalledWith({
        agent: 'codex',
        workspacePath: '/repo/wt',
        accountHomePath: '/homes/selected'
      })
    })

    it('keeps the listed default when nothing in the workspace can replace it', async () => {
      const { service } = serviceWith(false)
      expect(defaults(await service.read({ agent: 'codex', workspacePath: '/repo/wt' }))).toEqual([
        true
      ])
    })

    it('names no default for a workspace it could not place on this machine', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(false)
      expect(defaults(await service.read({ agent: 'codex', workspacePath: null }))).toEqual([false])
      expect(workspaceMayOverrideDefaultModel).not.toHaveBeenCalled()
    })

    it('leaves a read that names no workspace as it was', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(true)
      expect(defaults(await service.read({ agent: 'codex' }))).toEqual([true])
      expect(workspaceMayOverrideDefaultModel).not.toHaveBeenCalled()
    })
  })
})

describe('catalog identity of the selected command', () => {
  it('keeps legacy cached listings and each command/prefix pair separate', async () => {
    const store = new AgentModelCatalogStore()
    store.recordSuccess(selectedHomeFingerprint('/homes/a'), 'codex', listing('legacy'))
    let command = '/commands/first'
    let prefixArgs = ['--profile', 'work']
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => CODEX_HOME('/homes/a'),
      prepareProbe: async () => {
        const invocation = { command, prefixArgs: [...prefixArgs] }
        return {
          invocation,
          probe: async () => listing(`${invocation.command}:${invocation.prefixArgs.join(' ')}`)
        }
      }
    })
    const first = await service.read({ agent: 'codex', waitForListing: true })
    expect(first.origin === 'unknown' ? null : first.models[0]?.id).toBe(
      '/commands/first:--profile work'
    )
    command = '/commands/second'
    const second = await service.read({ agent: 'codex', waitForListing: true })
    expect(second.origin === 'unknown' ? null : second.models[0]?.id).toBe(
      '/commands/second:--profile work'
    )
    prefixArgs = ['--profile', 'personal']
    const third = await service.read({ agent: 'codex', waitForListing: true })
    expect(third.origin === 'unknown' ? null : third.models[0]?.id).toBe(
      '/commands/second:--profile personal'
    )
    expect(store.get(selectedHomeFingerprint('/homes/a'))?.models[0]?.id).toBe('legacy')
  })

  it('pins an in-flight probe to the invocation that named its cache key', async () => {
    const store = new AgentModelCatalogStore()
    let command = '/commands/first'
    let firstStarted = false
    let finishFirst: (value: AgentModelCatalogSuccess) => void = () => {}
    const firstResult = new Promise<AgentModelCatalogSuccess>((resolve) => {
      finishFirst = resolve
    })
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => CODEX_HOME('/homes/a'),
      prepareProbe: async () => {
        const invocation = { command, prefixArgs: [] }
        return {
          invocation,
          probe: async () => {
            firstStarted = true
            return invocation.command.endsWith('first') ? firstResult : listing('second')
          }
        }
      }
    })
    const first = service.read({ agent: 'codex', waitForListing: true })
    await vi.waitFor(() => expect(firstStarted).toBe(true))
    command = '/commands/second'
    const second = await service.read({ agent: 'codex', waitForListing: true })
    finishFirst(listing('first'))
    const firstListed = await first
    expect(firstListed.origin === 'unknown' ? null : firstListed.models[0]?.id).toBe('first')
    expect(second.origin === 'unknown' ? null : second.models[0]?.id).toBe('second')
  })

  it('refreshes a live session through its pinned command after the setting changes', async () => {
    const store = new AgentModelCatalogStore()
    const invocation = { command: '/commands/live', prefixArgs: ['code'] }
    const access = agentModelCatalogSessionAccess(store, 'codex', '/homes/a', invocation)
    const prepareProbe = vi.fn<NonNullable<AgentModelCatalogServiceDeps['prepareProbe']>>(
      async (_agent, _cwd, pinned) => ({
        invocation: pinned ?? { command: '/commands/new-setting', prefixArgs: [] },
        probe: async () => listing(pinned?.command ?? 'new-setting')
      })
    )
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record('/homes/a'),
      resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
      readSessionCatalogAccess: () => access,
      resolveWorkspacePath: async () => '/workspace',
      prepareProbe
    })
    const result = await service.read({
      agent: 'codex',
      sessionId: 'session-1',
      waitForListing: true
    })
    expect(prepareProbe).toHaveBeenCalledWith('codex', '/workspace', invocation)
    expect(result.origin === 'unknown' ? null : result.models[0]?.id).toBe('/commands/live')
    expect(store.get(access?.fingerprint ?? '')?.models[0]?.id).toBe('/commands/live')
  })

  it('does not serve the default listing when the current command fails resolution', async () => {
    const store = new AgentModelCatalogStore()
    store.recordSuccess(selectedHomeFingerprint('/homes/a'), 'codex', listing('legacy'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => CODEX_HOME('/homes/a'),
      prepareProbe: async () => {
        throw new Error('command missing')
      }
    })
    expect(await service.read({ agent: 'codex' })).toEqual({ origin: 'unknown' })
  })
})

it('keeps a live child’s cached listing when fresh probe environment resolution fails', async () => {
  const store = new AgentModelCatalogStore()
  const access = agentModelCatalogSessionAccess(store, 'codex', '/homes/a', {
    command: '/live/wrapper',
    prefixArgs: ['code']
  })
  if (!access) {
    throw new Error('missing session catalog')
  }
  store.recordSuccess(access.fingerprint, 'codex', listing('live'))
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => record('/homes/a'),
    resolveAccountHome: async () => CODEX_HOME('/homes/a'),
    readSessionCatalogAccess: () => access,
    prepareProbe: async () => {
      throw new Error('fresh environment unavailable')
    }
  })
  const result = await service.read({ agent: 'codex', sessionId: 'session-1' })
  expect(result.origin === 'unknown' ? null : result.models[0]?.id).toBe('live')
})

it('isolates identical relative wrapper arguments by their execution directory', async () => {
  const store = new AgentModelCatalogStore()
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => undefined,
    resolveAccountHome: async () => CODEX_HOME('/homes/a'),
    prepareProbe: async (_agent, cwd) => ({
      invocation: { command: '/runtime/node', prefixArgs: ['./wrapper.js'], cwd },
      probe: async () => listing(cwd ?? 'no-workspace')
    })
  })
  const first = await service.read({
    agent: 'codex',
    workspacePath: '/workspace/a',
    waitForListing: true
  })
  const second = await service.read({
    agent: 'codex',
    workspacePath: '/workspace/b',
    waitForListing: true
  })
  expect(first.origin === 'unknown' ? null : first.models[0]?.id).toBe('/workspace/a')
  expect(second.origin === 'unknown' ? null : second.models[0]?.id).toBe('/workspace/b')
})
