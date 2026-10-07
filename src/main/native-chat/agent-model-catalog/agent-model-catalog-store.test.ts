import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AGENT_MODEL_CATALOG_MAX_ENTRIES,
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  AgentModelCatalogStore,
  AgentModelCatalogUnavailableError,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSessionAccess,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

function models(...ids: string[]): AgentSessionModelOption[] {
  return ids.map((id, index) => ({
    id,
    label: id.toUpperCase(),
    isDefault: index === 0,
    efforts: [{ value: 'high', label: 'High' }]
  }))
}

function success(...ids: string[]): AgentModelCatalogSuccess {
  return {
    models: models(...ids),
    fastModeTierByModel: new Map([[ids[0]!, 'fast-tier']]),
    origin: 'live-session'
  }
}

/** A live session's per-spawn handle; each call is a distinct lister. */
function liveLister(store: AgentModelCatalogStore): AgentModelCatalogSessionAccess {
  return { store, fingerprint: 'fp-1', accountHomePath: '/homes/a' }
}

describe('agent model catalog store', () => {
  it('serves an entry at any age and flags staleness at the refresh threshold', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    const entry = store.get('fp-1')!
    expect(entry.models.map((model) => model.id)).toEqual(['gpt-a'])
    expect(store.isStale(entry)).toBe(false)
    expect(store.shouldRefresh('fp-1')).toBe(false)
    at += AGENT_MODEL_CATALOG_FRESH_MS
    expect(store.get('fp-1')).not.toBeNull()
    expect(store.shouldRefresh('fp-1')).toBe(true)
  })

  it('never memoizes an empty list as a catalog', () => {
    const store = new AgentModelCatalogStore()
    expect(
      store.recordSuccess('fp-1', 'codex', {
        models: [],
        fastModeTierByModel: new Map(),
        origin: 'live-session'
      })
    ).toBeNull()
    expect(store.get('fp-1')).toBeNull()
  })

  it('holds a failure under its TTL without touching the last good entry', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    store.recordFailure('fp-1', 'timed out')
    expect(store.get('fp-1')!.models.map((model) => model.id)).toEqual(['gpt-a'])
    expect(store.hasActiveFailure('fp-1')).toBe(true)
    expect(store.failureDetail('fp-1')).toBe('timed out')
    expect(store.shouldRefresh('fp-1')).toBe(false)
    at += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    expect(store.hasActiveFailure('fp-1')).toBe(false)
  })

  it('joins an in-flight refresh instead of starting a second fetch', async () => {
    const store = new AgentModelCatalogStore()
    let settle!: (value: AgentModelCatalogSuccess) => void
    const fetch = vi.fn(
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settle = resolve))
    )
    const session = liveLister(store)
    const first = store.refresh('fp-1', 'codex', session, fetch)
    const second = store.refresh('fp-1', 'codex', session, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    settle(success('gpt-a'))
    const [entryA, entryB] = await Promise.all([first, second])
    expect(entryA).toBe(entryB)
    expect(entryA!.models[0]!.id).toBe('gpt-a')
  })

  it('never makes a live session wait on another lister that hangs', async () => {
    const store = new AgentModelCatalogStore()
    let failProbe!: (error: Error) => void
    const hungProbe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((_resolve, reject) => (failProbe = reject))
    const probe = store.refresh('fp-1', 'codex', hungProbe, () => hungProbe('/homes/a'))
    expect(store.shouldRefresh('fp-1')).toBe(false)

    const live = await store.refresh('fp-1', 'codex', liveLister(store), async () =>
      success('gpt-live')
    )
    expect(live!.models[0]!.id).toBe('gpt-live')

    // The probe still reports its own failure; the live listing it lost to stays served.
    failProbe(new Error('codex app-server session exceeded 15000ms'))
    expect(await probe).toBeNull()
    expect(store.failureDetail('fp-1')).toBe('codex app-server session exceeded 15000ms')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-live')
  })

  it('answers a pending read with the first listing that succeeds, or null once all fail', async () => {
    const store = new AgentModelCatalogStore()
    expect(store.pendingListing('fp-1')).toBeNull()
    let failFirst!: (error: Error) => void
    let settleSecond!: (success: AgentModelCatalogSuccess) => void
    void store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((_resolve, reject) => (failFirst = reject))
    )
    void store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleSecond = resolve))
    )
    const pending = store.pendingListing('fp-1')
    failFirst(new Error('stuck'))
    settleSecond(success('gpt-second'))
    expect((await pending)!.models[0]!.id).toBe('gpt-second')

    void store.refresh('fp-2', 'codex', liveLister(store), async () => {
      throw new Error('no provider')
    })
    expect(await store.pendingListing('fp-2')).toBeNull()
  })

  it('ends a picker wait at its deadline even while a listing remains active', async () => {
    vi.useFakeTimers()
    try {
      const store = new AgentModelCatalogStore()
      let settle!: (success: AgentModelCatalogSuccess) => void
      const listing = store.refresh(
        'fp-1',
        'codex',
        liveLister(store),
        () => new Promise<AgentModelCatalogSuccess>((resolve) => (settle = resolve))
      )
      const waited = store.pendingListing('fp-1')
      await vi.advanceTimersByTimeAsync(AGENT_MODEL_CATALOG_PICKER_WAIT_MS)
      expect(await waited).toBeNull()
      settle(success('gpt-late'))
      expect((await listing)!.models[0]!.id).toBe('gpt-late')
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds back a probe until every lister settles, then lets the account refresh again', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    let settleSlow!: (success: AgentModelCatalogSuccess) => void
    const slow = store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleSlow = resolve))
    )
    await store.refresh('fp-1', 'codex', liveLister(store), async () => success('gpt-fast'))
    at += AGENT_MODEL_CATALOG_FRESH_MS
    expect(store.shouldRefresh('fp-1')).toBe(false)

    settleSlow(success('gpt-slow'))
    await slow
    at += AGENT_MODEL_CATALOG_FRESH_MS
    // A leftover in-flight record here would suppress every later refresh for the account.
    expect(store.shouldRefresh('fp-1')).toBe(true)
  })

  it('keeps the newer completed listing when an older chat finishes later', async () => {
    const store = new AgentModelCatalogStore()
    const save = vi.fn()
    await store.attachPersistence({ load: async () => [], save, flush: async () => {} })
    let settleOlder!: (success: AgentModelCatalogSuccess) => void
    const older = store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleOlder = resolve))
    )
    const newer = await store.refresh('fp-1', 'codex', liveLister(store), async () =>
      success('gpt-new')
    )
    settleOlder(success('gpt-old'))
    const olderResult = await older

    expect(newer!.models[0]!.id).toBe('gpt-new')
    expect(olderResult!.models[0]!.id).toBe('gpt-old')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-new')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps a direct live update ahead of a pending older probe', async () => {
    const store = new AgentModelCatalogStore()
    let settleProbe!: (success: AgentModelCatalogSuccess) => void
    const probe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (settleProbe = resolve))
    const pending = store.refresh('fp-1', 'codex', probe, () => probe('/homes/a'))
    store.recordSuccess('fp-1', 'codex', success('gpt-live'))
    settleProbe({ ...success('gpt-probe'), origin: 'probe' })
    expect((await pending)!.models[0]!.id).toBe('gpt-probe')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-live')
  })

  it('keeps an older successful listing when the newer entry was evicted', async () => {
    const store = new AgentModelCatalogStore()
    let settleOlder!: (success: AgentModelCatalogSuccess) => void
    const older = store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleOlder = resolve))
    )
    await store.refresh('fp-1', 'codex', liveLister(store), async () => success('gpt-new'))
    for (let index = 0; index < AGENT_MODEL_CATALOG_MAX_ENTRIES; index++) {
      store.recordSuccess(`other-${index}`, 'codex', success('other'))
    }
    expect(store.get('fp-1')).toBeNull()
    const save = vi.fn()
    await store.attachPersistence({ load: async () => [], save, flush: async () => {} })

    settleOlder(success('gpt-old'))
    expect((await older)!.models[0]!.id).toBe('gpt-old')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-old')
    expect(save).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ fingerprint: 'fp-1' })])
    )
  })

  it('records a failed refresh as a failure and resolves null without rejecting', async () => {
    const store = new AgentModelCatalogStore()
    const entry = await store.refresh('fp-1', 'codex', liveLister(store), async () => {
      throw new Error('no provider')
    })
    expect(entry).toBeNull()
    expect(store.get('fp-1')).toBeNull()
    expect(store.hasActiveFailure('fp-1')).toBe(true)
    expect(store.failureDetail('fp-1')).toBe('no provider')
  })

  it('keys entries by fingerprint so one account never answers for another', () => {
    const fingerprintA = agentModelCatalogFingerprint({
      agent: 'codex',
      accountHomeVariable: 'CODEX_HOME',
      accountHomePath: '/homes/a',
      wslDistro: null
    })
    const fingerprintB = agentModelCatalogFingerprint({
      agent: 'codex',
      accountHomeVariable: 'CODEX_HOME',
      accountHomePath: '/homes/b',
      wslDistro: null
    })
    expect(fingerprintA).not.toBe(fingerprintB)
    const store = new AgentModelCatalogStore()
    store.recordSuccess(fingerprintA, 'codex', success('gpt-a'))
    expect(store.get(fingerprintB)).toBeNull()
  })

  it('derives the record fingerprint from the pinned account home', () => {
    const record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'> = {
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'ws-1',
        workspaceKind: 'git-worktree'
      }
    }
    expect(agentModelCatalogFingerprintForRecord(record)).toBe(
      agentModelCatalogFingerprint({
        agent: 'codex',
        accountHomeVariable: 'CODEX_HOME',
        accountHomePath: '/homes/a',
        wslDistro: null
      })
    )
  })

  it('rewrites the file only when a listing changes, while still refreshing its age', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    const save = vi.fn()
    void store.attachPersistence({ load: async () => [], save, flush: async () => {} })
    store.recordSuccess('fp', 'claude', success('opus'))
    at += AGENT_MODEL_CATALOG_FRESH_MS
    store.recordSuccess('fp', 'claude', success('opus'))
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.shouldRefresh('fp')).toBe(false)
    store.recordSuccess('fp', 'claude', success('opus', 'sonnet'))
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("keeps a live child's default effort through a listing that names none, across a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const efforts = [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ]
    const listing = (defaultEffort?: string): AgentModelCatalogSuccess => ({
      models: [
        {
          id: 'opus',
          label: 'Opus',
          isDefault: true,
          efforts,
          ...(defaultEffort ? { defaultEffort } : {})
        }
      ],
      fastModeTierByModel: new Map(),
      origin: 'live-session'
    })
    store.recordSuccess('fp', 'claude', listing('medium'))
    // A session-less probe never names Claude's default.
    store.recordSuccess('fp', 'claude', { ...listing(), origin: 'probe' })
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('medium')
    await store.flushPersistence()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restarted.get('fp')!.models[0]!.defaultEffort).toBe('medium')

    // A newer report replaces it; a model that stops offering it drops it.
    store.recordSuccess('fp', 'claude', listing('high'))
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('high')
    store.recordSuccess('fp', 'claude', {
      ...listing(),
      models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [efforts[0]!] }]
    })
    expect(store.get('fp')!.models[0]).not.toHaveProperty('defaultEffort')
  })

  it('persists successes only and hydrates them across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    store.recordFailure('fp-2', 'timed out')
    await vi.waitFor(
      async () => {
        const persisted = await createAgentModelCatalogFilePersistence(directory).load()
        expect(persisted.map((entry) => entry.fingerprint)).toEqual(['fp-1'])
      },
      { timeout: 3_000 }
    )
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const entry = restarted.get('fp-1')!
    expect(entry.models.map((model) => model.id)).toEqual(['gpt-a'])
    expect(entry.fastModeTierByModel).toEqual({ 'gpt-a': 'fast-tier' })
    // The failure died with the process: doubt is never a durable fact.
    expect(restarted.hasActiveFailure('fp-2')).toBe(false)
    expect(restarted.get('fp-2')).toBeNull()
  })

  it('writes a coalesced save at once when flushed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    await store.flushPersistence()
    const persisted = await createAgentModelCatalogFilePersistence(directory).load()
    expect(persisted.map((entry) => entry.fingerprint)).toEqual(['fp-1'])
  })

  it('loads nothing from a malformed persistence file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const persistence = createAgentModelCatalogFilePersistence(directory)
    expect(await persistence.load()).toEqual([])
  })
})

describe("the account's status beside the catalog", () => {
  function blockedStore(at: { now: number }) {
    const store = new AgentModelCatalogStore({ now: () => at.now })
    const signedOut: AgentModelCatalogProbe = async () => {
      throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn', account: 'system' })
    }
    const block = () => store.refresh('fp-1', 'codex', signedOut, () => signedOut('/homes/a'))
    return { store, block }
  }
  const status = (store: AgentModelCatalogStore) => store.statuses.get('fp-1', true)

  it("is the probe's alone: a chat's own listings neither change nor renew it", async () => {
    const at = { now: 1_000 }
    const { store, block } = blockedStore(at)
    await block()
    at.now += 10_000
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    await store.refresh('fp-1', 'codex', liveLister(store), async () => success('gpt-b'))
    store.recordFailure('fp-1', 'model/list timed out')
    expect(store.get('fp-1')!.models.map((model) => model.id)).toEqual(['gpt-b'])
    expect(status(store)).toEqual({
      state: 'notSignedIn',
      account: 'system',
      recheckInMs: AGENT_MODEL_CATALOG_FAILURE_TTL_MS - 10_000
    })
  })

  it('a probe success says ready; an untyped probe failure says nothing', async () => {
    const at = { now: 1_000 }
    const { store, block } = blockedStore(at)
    await block()
    const listed: AgentModelCatalogProbe = async () => ({ ...success('gpt-a'), origin: 'probe' })
    await store.refresh('fp-1', 'codex', listed, () => listed('/homes/a'))
    expect(status(store)).toEqual({ state: 'ready' })
    const timedOut: AgentModelCatalogProbe = async () => {
      throw new Error('timeout')
    }
    await store.refresh('fp-1', 'codex', timedOut, () => timedOut('/homes/a'))
    expect(status(store)).toBeUndefined()
  })

  it('stands past its TTL until re-derived, and only a blocked one asks for the probe', async () => {
    const at = { now: 1_000 }
    const { store, block } = blockedStore(at)
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    await block()
    expect(store.statuses.needsProbe('fp-1')).toBe(false)
    at.now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    expect(status(store)).toMatchObject({
      state: 'notSignedIn',
      recheckInMs: AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    })
    expect(store.statuses.needsProbe('fp-1')).toBe(true)
    // A chat's own picker never re-lists for it; only the catalog read's probe answers it.
    expect(store.shouldRefresh('fp-1')).toBe(false)
    // With nothing able to re-derive it, an aged blocked answer is not served.
    expect(store.statuses.get('fp-1', false)).toBeUndefined()
  })

  it('never re-probes a healthy fresh catalog inside the fresh window', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    const listed: AgentModelCatalogProbe = async () => ({ ...success('gpt-a'), origin: 'probe' })
    await store.refresh('fp-1', 'codex', listed, () => listed('/homes/a'))
    at += AGENT_MODEL_CATALOG_FRESH_MS - 1
    expect(store.shouldRefresh('fp-1')).toBe(false)
    expect(store.statuses.needsProbe('fp-1')).toBe(false)
  })

  it('a probe that started before newer evidence cannot replace it', async () => {
    const at = { now: 1_000 }
    const store = new AgentModelCatalogStore({ now: () => at.now })
    let answer!: (value: AgentModelCatalogSuccess) => void
    const slow: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (answer = resolve))
    const running = store.refresh('fp-1', 'claude', slow, () => slow('/homes/a'))
    at.now += 1_000
    // The same CLI refused a start under this home after the probe began.
    store.statuses.record('fp-1', 'claude', { state: 'notSignedIn' })
    answer({ ...success('gpt-a'), origin: 'probe' })
    await running
    expect(status(store)).toMatchObject({ state: 'notSignedIn' })
  })

  it("an account change marks only that agent's answers, which stand until re-probed", async () => {
    const at = { now: 1_000 }
    const { store, block } = blockedStore(at)
    await block()
    store.statuses.recheck('claude')
    expect(store.statuses.needsProbe('fp-1')).toBe(false)
    let answer!: (value: AgentModelCatalogSuccess) => void
    const slow: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (answer = resolve))
    const startedBefore = store.refresh('fp-1', 'codex', slow, () => slow('/homes/a'))
    at.now += 1_000
    store.statuses.recheck('codex')
    expect(store.statuses.needsProbe('fp-1')).toBe(true)
    expect(status(store)).toMatchObject({ state: 'notSignedIn' })
    // A probe already running read the old account: its answer does not settle the change.
    answer({ ...success('gpt-a'), origin: 'probe' })
    await startedBefore
    expect(status(store)).toMatchObject({ state: 'notSignedIn' })
    expect(store.statuses.needsProbe('fp-1')).toBe(true)
  })

  it('orders evidence by sequence, so a clock that steps back neither freezes nor keeps it', async () => {
    const at = { now: 100_000 }
    const { store, block } = blockedStore(at)
    await block()
    at.now = 1_000
    // Due now, rather than frozen until the clock catches up.
    expect(store.statuses.needsProbe('fp-1')).toBe(true)
    const listed: AgentModelCatalogProbe = async () => ({ ...success('gpt-a'), origin: 'probe' })
    await store.refresh('fp-1', 'codex', listed, () => listed('/homes/a'))
    expect(status(store)).toEqual({ state: 'ready' })
    // A refused start, then an account change, still settle in the order they happened.
    at.now = 500
    store.statuses.record('fp-1', 'codex', { state: 'cliMissing' })
    expect(status(store)).toMatchObject({ state: 'cliMissing' })
    store.statuses.recheck('codex')
    at.now = 100
    await store.refresh('fp-1', 'codex', listed, () => listed('/homes/a'))
    expect(status(store)).toEqual({ state: 'ready' })
  })

  it('spaces out probes that keep finding the same block, up to its cap', async () => {
    const at = { now: 1_000 }
    const { store, block } = blockedStore(at)
    const holds: number[] = []
    for (let probe = 0; probe < 6; probe += 1) {
      await block()
      const hold = store.statuses.get('fp-1', true)
      holds.push(hold && hold.state !== 'ready' ? hold.recheckInMs : 0)
      // The client's timer reads again when the hold is up, which is past the TTL.
      at.now += holds.at(-1)!
      expect(store.statuses.needsProbe('fp-1')).toBe(true)
    }
    expect(holds).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000])
  })

  it("re-checks a read past the TTL, inside the timer's backed-off hold", async () => {
    const at = { now: 1_000 }
    const { store, block } = blockedStore(at)
    await block()
    await block()
    await block()
    at.now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS - 1
    expect(store.statuses.needsProbe('fp-1')).toBe(false)
    at.now += 1
    expect(store.statuses.needsProbe('fp-1')).toBe(true)
    // The timer is still told to wait out the rest of its 2 min hold.
    expect(status(store)).toMatchObject({ recheckInMs: 90_000 })
  })

  it("an account change during a home's first probe drops that probe's old-account answer", async () => {
    const store = new AgentModelCatalogStore({ now: () => 1_000 })
    let answer!: (value: AgentModelCatalogSuccess) => void
    const slow: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (answer = resolve))
    const first = store.refresh('fp-1', 'claude', slow, () => slow('/homes/a'))
    store.statuses.recheck('claude')
    expect(store.statuses.probeStartedBeforeRecheck('fp-1')).toBe(true)
    answer({ ...success('gpt-a'), origin: 'probe' })
    await first
    expect(status(store)).toBeUndefined()
    // The next probe began after the change, so its answer stands.
    const next = store.refresh('fp-1', 'claude', slow, () => slow('/homes/a'))
    expect(store.statuses.probeStartedBeforeRecheck('fp-1')).toBe(false)
    answer({ ...success('gpt-a'), origin: 'probe' })
    await next
    expect(status(store)).toEqual({ state: 'ready' })
  })

  it('starts the hold over after an account change or a different refusal', async () => {
    const at = { now: 1_000 }
    const { store, block } = blockedStore(at)
    const hold = () => {
      const answer = store.statuses.get('fp-1', true)
      return answer && answer.state !== 'ready' ? answer.recheckInMs : 0
    }
    await block()
    await block()
    expect(hold()).toBe(60_000)
    store.statuses.recheck('codex')
    await block()
    expect(hold()).toBe(30_000)
    await block()
    expect(hold()).toBe(60_000)
    // The same refusal from a start keeps the pace; a different one starts over.
    store.statuses.record('fp-1', 'codex', { state: 'notSignedIn', account: 'system' })
    expect(hold()).toBe(60_000)
    store.statuses.record('fp-1', 'codex', { state: 'cliMissing' })
    expect(hold()).toBe(30_000)
  })

  it('a synchronous probe fault never rejects the catalog read', async () => {
    const store = new AgentModelCatalogStore()
    const faulty: AgentModelCatalogProbe = () => {
      throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
    }
    await expect(store.refresh('a', 'codex', faulty, () => faulty('/homes/a'))).resolves.toBeNull()
    expect(store.statuses.get('a', true)).toMatchObject({ state: 'cliMissing' })
  })
})
