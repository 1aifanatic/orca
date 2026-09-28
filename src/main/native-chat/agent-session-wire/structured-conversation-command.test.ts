import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session-conversation-command'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const caller = { callerKey: 'desktop' }
let directory: string
let generation: number
let clock: number
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let hosts: StructuredAgentSessionHost[]
let adapter: StructuredAgentSessionAdapter
const compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>()
let acquisitions = 0

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: HOST_TEST_SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: HOST_TEST_SESSION,
      fields
    })
  }
}

function commandParams(command: AgentSessionConversationCommand) {
  return { command, envelope: envelope('agentSession.conversationCommand', { command }) }
}

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return { body, envelope: envelope('agentSession.send', { body }) }
}

const generationRoot = () => join(directory, `generation-${generation}`)

async function openHost(): Promise<void> {
  store = await AgentSessionRecordStore.open({
    directory: join(generationRoot(), 'store'),
    hostId: 'local'
  })
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: generationRoot(),
    claimKeyId: 'key',
    now: () => clock,
    mintSpawnToken: () => `spawn-${acquisitions}`,
    // The owners a restarted host finds died with the process that started them.
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
  hosts.push(host)
}

/** A crash and relaunch: the next host opens what the dying one had written, and nothing after. */
async function restartHost(): Promise<void> {
  await store.renewLeases([])
  const dying = generationRoot()
  generation++
  await cp(dying, generationRoot(), {
    recursive: true,
    filter: (source) => !source.endsWith('.tmp') && !source.includes('.lock')
  })
  await openHost()
}

beforeEach(async () => {
  resetHostTestOperationIds()
  acquisitions = 0
  generation = 0
  clock = HOST_TEST_NOW
  hosts = []
  compact.mockReset().mockResolvedValue({ state: 'accepted', providerIdentity: null })
  directory = await mkdtemp(join(tmpdir(), 'orca-conversation-command-'))
  adapter = {
    supportsLocation: (location) =>
      location.executionHostId === 'local' && location.wslDistro === null,
    acquire: vi.fn(async (input) => {
      acquisitions++
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquisitions,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: `link-${acquisitions}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: input.fence > 1 ? ('resumed' as const) : ('created' as const),
          handle: {
            provider: 'codex' as const,
            threadId:
              input.identity.providerHandle.kind === 'codex'
                ? input.identity.providerHandle.threadId
                : `00000000-0000-4000-8000-${String(acquisitions).padStart(12, '0')}`
          }
        }
      }
    }),
    dispatch: vi.fn(async () => ({ state: 'unknown' as const, reason: 'test' })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: async () => {},
    setOption: async () => {},
    compact,
    releaseAcquisition: vi.fn(async () => true),
    closeSession: vi.fn(async () => true),
    readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } })
  }
  await openHost()
  expect(
    await host.attach(caller, hostTestAttachParams(null, { options: { effort: 'low' } }))
  ).toMatchObject({ ok: true })
  await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
})

afterEach(async () => {
  for (const each of hosts) {
    await each.flushAllStreamedEvents()
  }
  await rm(directory, { recursive: true, force: true })
})

describe('host conversation commands', () => {
  it('adopts the reported Fast preference into the replacement record', async () => {
    adapter.readOptions = async () => ({
      models: [],
      current: { model: 'test-model', effort: 'high', fastMode: false }
    })
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(store.getRecord(result.value.replacementSessionId!)).toMatchObject({
      options: { model: 'test-model', effort: 'high', fastMode: 'false' }
    })
  })

  // What the child reports can be a value it fell back to, such as a model whose restore write it
  // never answered; the replacement's start replays the choice, as the source's next start would.
  it('starts the replacement from the options the user chose, not the values the child reports', async () => {
    await store.replaceSessionOptions({
      sessionId: HOST_TEST_SESSION,
      fence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      options: { model: 'test-model', effort: 'low' },
      now: HOST_TEST_NOW
    })
    adapter.readOptions = async () => ({
      models: [],
      current: { model: 'fallback-model', effort: 'high' }
    })
    const attach = vi.spyOn(host, 'attach')
    expect(await host.conversationCommand(caller, commandParams('clear'))).toMatchObject({
      ok: true
    })
    expect(attach.mock.calls[0]?.[1].options).toEqual({ model: 'test-model', effort: 'low' })
    expect(store.getRecord(HOST_TEST_SESSION)?.options).toEqual({
      model: 'test-model',
      effort: 'low'
    })
  })

  it('clears with a fresh record and effective options, retaining old history and idempotent mapping', async () => {
    const before = store.getRecord(HOST_TEST_SESSION)!
    const params = commandParams('clear')
    const result = await host.conversationCommand(caller, params)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const nextId = result.value.replacementSessionId!
    expect(nextId).not.toBe(HOST_TEST_SESSION)
    expect(store.getRecord(nextId)).toMatchObject({
      location: before.location,
      accountHome: before.accountHome,
      options: { model: 'test-model', effort: 'high' }
    })
    expect(store.getRecord(HOST_TEST_SESSION)).not.toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([nextId])
    expect((await host.history({ sessionId: nextId, direction: 'tail' })).page.items).toEqual([])
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { replacementSessionId: nextId }
    })
    expect(acquisitions).toBe(2)
    const body = hostTestMessage('late send')
    expect(
      await host.send(caller, {
        body,
        envelope: {
          ...params.envelope,
          clientOperationId: hostTestOperationId(),
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: HOST_TEST_SESSION,
            fields: { body }
          })
        }
      })
    ).toMatchObject({ ok: false })
    expect(adapter.dispatch).not.toHaveBeenCalled()
  })

  it('leaves the source usable when replacement creation is definitely refused', async () => {
    vi.spyOn(host, 'attach').mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: 'Unavailable' }
    })
    expect(await host.conversationCommand(caller, commandParams('clear'))).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: undefined, error: expect.any(String) }
    })
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    expect(acquisitions).toBe(1)
    expect(await host.conversationCommand(caller, commandParams('compact'))).toMatchObject({
      ok: true
    })
  })

  it('runs a command whose fence the client has not caught up to', async () => {
    const params = commandParams('compact')
    params.envelope.expectedRuntimeFence++
    expect(await host.conversationCommand(caller, params)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
  })
  it('reconstructs a committed replacement after the ledger settlement is lost', async () => {
    const persist = store.recordOperationOutcome.bind(store)
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (input.outcome.status === 'succeeded' && input.outcome.conversationCommand) {
        throw new Error('crash')
      }
      return persist(input)
    })
    const params = commandParams('clear')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow('crash')
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: 'completed' }
    })
    expect(acquisitions).toBe(2)
  })

  it('keeps explicitly revealed history and closed replacement tabs out of automatic restoration', async () => {
    const result = await host.conversationCommand(caller, commandParams('clear'))
    if (!result.ok) {
      throw new Error('clear failed')
    }
    expect(host.conversationReplacements()).toHaveLength(1)
    await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
    expect(host.conversationReplacements()).toEqual([])
    await host.setSessionTabVisibility(HOST_TEST_SESSION, false)
    await host.setSessionTabVisibility(result.value.replacementSessionId!, false)
    expect(host.conversationReplacements()).toEqual([])
  })
})

describe('a clear that never committed', () => {
  /** The replacement's start answers with a refusal that proves nothing either way. */
  function refuseReplacementStartOnce() {
    vi.spyOn(host, 'attach').mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_capacity', message: 'Too many operations.' }
    })
  }

  async function clearCommits(params = commandParams('clear')) {
    const result = await host.conversationCommand(caller, params)
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: expect.any(String) }
    })
    return result.ok ? result.value.replacementSessionId! : ''
  }

  it('refuses nothing afterwards: a rewind, a compaction and a send all run', async () => {
    adapter.rewindSupport = () => ({ supported: true })
    refuseReplacementStartOnce()
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow(
      'Too many operations.'
    )
    // Past every conversation check: only the stale epoch it names stops it.
    expect(
      await host.rewind(caller, {
        envelope: envelope('agentSession.rewind', {
          itemId: 'item-1',
          expectedEpoch: 'stale-epoch'
        }),
        itemId: 'item-1',
        expectedEpoch: 'stale-epoch'
      })
    ).toMatchObject({ ok: false, refusal: { rewindReason: 'stale-epoch' } })
    expect(await host.conversationCommand(caller, commandParams('compact'))).toMatchObject({
      ok: true
    })
    expect(await host.send(caller, sendParams('still here'))).toMatchObject({ ok: true })
  })

  it('lets a clear under a new operation id commit', async () => {
    refuseReplacementStartOnce()
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow()
    const replacement = await clearCommits()
    expect(store.listVisibleSessionIds()).toEqual([replacement])
  })

  it('reruns under the same operation id and starts exactly one replacement', async () => {
    refuseReplacementStartOnce()
    const params = commandParams('clear')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow()
    expect(acquisitions).toBe(1)
    await clearCommits(params)
    expect(acquisitions).toBe(2)
  })

  /** What an older build left when its clear's outcome was lost: gated every write until now. */
  async function restartOverAnOlderBuildsUnconfirmedClear() {
    const record = store.getRecord(HOST_TEST_SESSION)!
    await store.setConversationCommand(HOST_TEST_SESSION, record.lease.runtimeFence, {
      command: 'clear',
      runtimeFence: record.lease.runtimeFence,
      operationId: hostTestOperationId(),
      callerKey: caller.callerKey,
      phase: 'prepared',
      state: 'unknown',
      replacementSessionId: 'clear-from-an-older-build'
    })
    await restartHost()
  }

  it("accepts a send on a restarted host holding an older build's unconfirmed clear", async () => {
    await restartOverAnOlderBuildsUnconfirmedClear()
    expect(await host.send(caller, sendParams('after the restart'))).toMatchObject({ ok: true })
  })

  it("clears on a restarted host holding an older build's unconfirmed clear", async () => {
    await restartOverAnOlderBuildsUnconfirmedClear()
    await clearCommits()
  })

  /** A clear whose replacement started but whose commit never landed; answers that replacement. */
  async function clearThatDiesBeforeItsCommit(params = commandParams('clear')): Promise<string> {
    const commit = store.setConversationCommand.bind(store)
    let crashed = false
    vi.spyOn(store, 'setConversationCommand').mockImplementation(async (...args) => {
      if (!crashed && args[2].phase === 'committed' && args[2].replacementSessionId) {
        crashed = true
        throw new Error('crash before the commit')
      }
      return commit(...args)
    })
    await expect(host.conversationCommand(caller, params)).rejects.toThrow(
      'crash before the commit'
    )
    const [orphan] = store
      .listRecords()
      .flatMap((record) => (record.sessionId === HOST_TEST_SESSION ? [] : [record.sessionId]))
    expect(host.collaboratorsForTests().sessions.get(orphan!)?.child).toBeTruthy()
    return orphan!
  }

  // Nothing points at that replacement, so nothing lists, opens or starts it. Its agent is the
  // only thing it holds, and it ends the way every quiet agent does.
  it('leaves a replacement it never pointed at unlisted, and its agent stopped once idle', async () => {
    const orphan = await clearThatDiesBeforeItsCommit()
    const replacement = await clearCommits()
    expect(replacement).not.toBe(orphan)
    expect(store.listVisibleSessionIds()).toEqual([replacement])
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([replacement])
    clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
    await host.collaboratorsForTests().lifetime.idleSweep.tick()
    expect(host.collaboratorsForTests().sessions.has(orphan)).toBe(false)
    expect(store.getRecord(orphan)?.lease).toMatchObject({ claimStatus: 'released' })
  })

  // The replacement's start cannot be replayed once the crash released it, so the retry clears
  // nothing; what matters here is that it starts no second replacement and latches nothing.
  it('retried under the same operation id after a crash, starts no second replacement and leaves the chat usable', async () => {
    const params = commandParams('clear')
    const orphan = await clearThatDiesBeforeItsCommit(params)
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())
    expect(await host.conversationCommand(caller, params)).toMatchObject({ ok: true })
    expect(
      store
        .listRecords()
        .map((record) => record.sessionId)
        .toSorted()
    ).toEqual([orphan, HOST_TEST_SESSION].toSorted())
    expect(await host.send(caller, sendParams('after the retry'))).toMatchObject({ ok: true })
  })

  it('starts nothing for that replacement after a crash, and releases what it held', async () => {
    const orphan = await clearThatDiesBeforeItsCommit()
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())
    const replacement = await clearCommits()
    expect(store.listVisibleSessionIds()).toEqual([replacement])
    expect(host.conversationReplacements().map((entry) => entry.sessionId)).toEqual([replacement])
    expect(host.collaboratorsForTests().sessions.has(orphan)).toBe(false)
    const started = vi.mocked(adapter.acquire).mock.calls.map(([input]) => input.identity.sessionId)
    expect(started.filter((sessionId) => sessionId === orphan)).toHaveLength(1)
    expect(store.getRecord(orphan)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })
  })
})
