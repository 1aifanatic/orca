// A chat whose lease bookkeeping failed while its agent ended, against the real host and the real
// chat journal database. The exit, the stop or the failed start was proven; only the write that
// would have recorded it failed. The next send must start the agent, and the renewer must land the
// missed write, because the host derives the lease from what it proved rather than what is stored.
//
// The database is made read-only with `query_only`, the journal database's own SQLITE_READONLY,
// which fails the record write and the journal write together as one unwritable store does.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { observeStructuredWorker } from '../../runtime/structured-worker-authority'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'

const CALLER = { callerKey: 'client-1' }
const EXITED_AT = NOW + 5_000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let sink: StructuredAgentSessionEventSink | null
let logged: { message: string; scope: unknown }[]
/** What the host's owner probe answers; a dead pid by default, as after any of these endings. */
let probe: (record: { lease: { ownerProcess: unknown } }) => AgentSessionOwnerProbe

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function setStoreWritable(writable: boolean): void {
  openTestJournalHostDatabase(root).db.pragma(`query_only = ${writable ? 'OFF' : 'ON'}`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stranded-lease-'))
  resetHostTestOperationIds()
  logged = []
  sink = null
  probe = (record) =>
    record.lease.ownerProcess ? { outcome: 'pid-absent' } : { outcome: 'reservation-unused' }
  let generation = 0
  acquire = vi.fn(async ({ fence, spawnToken, events }) => {
    sink = events ?? null
    return {
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      acquisitionGeneration: `generation-${++generation}`,
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex' as const, threadId: THREAD },
        origin: store.getRecord(SESSION)?.providerHandleChain.length
          ? ('resumed' as const)
          : ('created' as const),
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  dispatch = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    logger: {
      warn: (message, fields) => logged.push({ message, scope: fields.scope }),
      error: (message, fields) => logged.push({ message, scope: fields.scope })
    },
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    probeOwner: async (record) => probe(record),
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    now: () => NOW
  })
  setStructuredAgentSessionHost(host)
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  setStoreWritable(true)
  setStructuredAgentSessionHost(null)
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function sendParams(text: string) {
  const body = hostTestMessage(text)
  const envelope: AgentSessionMutationEnvelope = {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    })
  }
  return { envelope, body }
}

/** The next send, which needs the agent this chat lost; resolves once it reached the provider. */
async function sendReachesTheAgent(text: string): Promise<void> {
  const params = sendParams(text)
  const dispatched = dispatch.mock.calls.length
  expect(await host.send(CALLER, params)).toMatchObject({ ok: true })
  await eventually(async () => {
    const snapshot = await host.journalSnapshot(SESSION)
    const errors = snapshot.items.flatMap((item) =>
      item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
    )
    const waiting = snapshot.submissions.flatMap((entry) =>
      entry.clientMessageId === params.envelope.clientOperationId ? [entry] : []
    )
    expect(
      dispatch.mock.calls.length,
      `error rows: ${JSON.stringify(errors)}; the send: ${JSON.stringify(waiting)}`
    ).toBe(dispatched + 1)
  })
}

function renewNow(): Promise<void> {
  const { runtimeState } = host.collaboratorsForTests()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the renewer is the runtime state's own private member; a tick is what this test drives.
  const internals = runtimeState as unknown as { leaseRenewer: { renewNow(): Promise<void> } }
  return internals.leaseRenewer.renewNow()
}

/** The provider exits while the store cannot take the release that records it. */
async function exitWhileStoreUnwritable(): Promise<number> {
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  setStoreWritable(false)
  await host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    reason: 'provider exited',
    cause: 'unexpected-exit',
    fence,
    acquisitionGeneration: 'generation-1',
    observedAt: EXITED_AT
  })
  expect(logged.map((entry) => entry.scope)).toContain('exit-owner-release')
  expect(store.getRecord(SESSION)?.lease).toMatchObject({
    claimStatus: 'live',
    runtimeFence: fence
  })
  setStoreWritable(true)
  return fence
}

describe('an exit whose release write failed', () => {
  it('lets the next send start the agent at the next fence', async () => {
    const fence = await exitWhileStoreUnwritable()

    await sendReachesTheAgent('after the exit')

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'live' })
    expect(store.getRecord(SESSION)!.lease.runtimeFence).toBeGreaterThan(fence)
  })

  it('reads as exited to every worker reader, never live', async () => {
    await exitWhileStoreUnwritable()

    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('exited')
  })

  it('lands the missed release on the next renewal tick, with the exit as its evidence', async () => {
    const fence = await exitWhileStoreUnwritable()

    await renewNow()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      runtimeFence: fence + 1,
      deathEvidence: { kind: 'exit-observed', observedAt: EXITED_AT, ownerFence: fence }
    })
  })

  it('keeps converging on later ticks while the store stays unwritable, reporting each failure', async () => {
    const fence = await exitWhileStoreUnwritable()
    setStoreWritable(false)
    await renewNow()
    expect(logged.map((entry) => entry.scope)).toContain('lease-convergence')
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')

    setStoreWritable(true)
    await renewNow()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: fence + 1
    })
  })

  it('starts the agent from a probe once the chat that watched the exit has closed', async () => {
    await exitWhileStoreUnwritable()
    await host.close(SESSION, 'evict')
    expect(host.hasSession(SESSION)).toBe(false)

    await sendReachesTheAgent('after closing and reopening')

    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('settles the turn the exit cut short as interrupted at the exit', async () => {
    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-0', ordinal: 0 },
      { kind: 'status', text: 'running', turnLifecycle: { turnId: 'turn-0', state: 'running' } },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
    await exitWhileStoreUnwritable()

    await sendReachesTheAgent('after the exit')

    const turn = (await host.journalSnapshot(SESSION)).items
      .map((item) => readAgentJournalTurn(item.body))
      .find((candidate) => candidate?.turnId === 'turn-0')
    expect(turn).toMatchObject({ state: 'interrupted', completedAt: EXITED_AT })
  })

  it('never frees a lease whose owner the host cannot prove gone', async () => {
    probe = () => ({ outcome: 'indeterminate', reason: 'no answer' })
    await exitWhileStoreUnwritable()
    await host.close(SESSION, 'evict')

    await renewNow()

    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('unverifiable')
  })
})

describe('a failed start whose settlement write failed', () => {
  async function failStartWithoutSettlement(): Promise<void> {
    await host.close(SESSION, 'evict')
    acquire.mockRejectedValueOnce(new Error('provider failed to start'))
    const settle = vi
      .spyOn(store, 'settleFailedAcquisition')
      .mockRejectedValueOnce(new Error('SQLITE_READONLY: attempt to write a readonly database'))
    expect(await host.send(CALLER, sendParams('the start fails'))).toMatchObject({ ok: true })
    await eventually(() => expect(settle).toHaveBeenCalledOnce())
    await eventually(async () => {
      const queued = (await host.journalSnapshot(SESSION)).submissions
      expect(queued.every((entry) => entry.dispatchState !== 'pending')).toBe(true)
    })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving'
    })
  }

  it('lets the next send start the agent once the probe proves the reservation unused', async () => {
    await failStartWithoutSettlement()

    await sendReachesTheAgent('after the failed start')

    expect(acquire).toHaveBeenCalledTimes(3)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('lands the abandoned reservation on the next renewal tick', async () => {
    await failStartWithoutSettlement()

    await renewNow()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      deathEvidence: { kind: 'pid-absent', detail: 'reservation never spawned' }
    })
  })

  it('never frees it while a process may still carry the token', async () => {
    await failStartWithoutSettlement()
    probe = () => ({ outcome: 'indeterminate', reason: 'token scan unavailable' })

    await renewNow()

    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('reserved')
  })
})

describe('a stop whose release write keeps failing', () => {
  it('does not hold the next send once the stop proved the agent gone', async () => {
    const transition = vi
      .spyOn(store, 'transitionHandoff')
      .mockRejectedValue(new Error('SQLITE_READONLY: attempt to write a readonly database'))
    const { serialize, lifetime } = host.collaboratorsForTests()
    await expect(
      serialize(SESSION, () => lifetime.stopAgent(SESSION, { cause: 'host-stop' }))
    ).rejects.toThrow()

    await sendReachesTheAgent('after the stop')

    expect(acquire).toHaveBeenCalledTimes(2)
    transition.mockRestore()
  })
})

describe('the owner verdict clients see across a normal attach', () => {
  /** Samples the published verdict before and after every lease write, and at the spawn. */
  function sampleVerdicts(sessionId: string): string[] {
    const verdicts: string[] = []
    const sample = () => verdicts.push(observeStructuredWorker({ sessionId }).status)
    const reserve = store.reserveOwner.bind(store)
    vi.spyOn(store, 'reserveOwner').mockImplementation(async (request) => {
      sample()
      return reserve(request).finally(sample)
    })
    const commit = store.commitProcessIdentity.bind(store)
    vi.spyOn(store, 'commitProcessIdentity').mockImplementation(async (args) => {
      sample()
      return commit(args).finally(sample)
    })
    const prove = store.proveOwner.bind(store)
    vi.spyOn(store, 'proveOwner').mockImplementation(async (args) => {
      sample()
      return prove(args).finally(sample)
    })
    const spawn = acquire.getMockImplementation()!
    acquire.mockImplementation(async (input) => {
      sample()
      return spawn(input)
    })
    return verdicts
  }

  it('never reads unverifiable while a resume starts the agent', async () => {
    await host.close(SESSION, 'evict')
    const verdicts = sampleVerdicts(SESSION)

    await sendReachesTheAgent('wakes the chat')

    expect(verdicts.length).toBeGreaterThan(6)
    expect(verdicts).not.toContain('unverifiable')
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('live')
  })

  it('never reads unverifiable while a create starts the agent', async () => {
    const created = 'session-beta'
    acquire.mockImplementation(async ({ fence, spawnToken }) => ({
      process: { hostId: 'local', pid: 4343, processStartTimeMs: 1_700_000_000_000, spawnToken },
      acquisitionGeneration: 'generation-beta',
      link: {
        linkId: `link-beta-${fence}`,
        handle: { provider: 'codex' as const, threadId: 'thread-beta' },
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: NOW
      }
    }))
    const verdicts = sampleVerdicts(created)

    expect(
      await host.attach(
        CALLER,
        hostTestAttachParams(null, {
          envelope: {
            sessionId: created,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: null,
            payloadFingerprint: ''
          },
          providerHandle: undefined
        })
      )
    ).toMatchObject({ ok: true })

    expect(verdicts.length).toBeGreaterThan(6)
    expect(verdicts).not.toContain('unverifiable')
    expect(observeStructuredWorker({ sessionId: created }).status).toBe('live')
  })
})
