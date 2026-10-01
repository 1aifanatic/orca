// A new chat whose agent cannot start is still created: it stands at rest, as after /clear, and its
// first message starts the agent and carries why it could not. QA saw instead a chat-level "Chat
// could not be started" line, and each message typed into it re-ran the whole create.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError,
  type AgentSessionPreSpawnReason,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
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
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { sendStructuredWorkerPreamble } from '../../runtime/rpc/methods/orchestration-structured-worker-session'

const CALLER = { callerKey: 'client-1' }

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let clock = NOW
let timers: { dueAt: number; run: () => void; cancelled: boolean }[] = []
// Runs before each spawn; throwing fails that start.
let beforeSpawn = vi.fn<() => Promise<void>>()
let acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>()
let releaseAcquisition = vi.fn<NonNullable<StructuredAgentSessionAdapter['releaseAcquisition']>>()
let dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
let statusSessions: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-create-at-rest-'))
  resetHostTestOperationIds()
  clock = NOW
  timers = []
  statusSessions = []
  beforeSpawn = vi.fn(async () => undefined)
  acquire = vi.fn(async ({ fence, spawnToken }) => {
    await beforeSpawn()
    return {
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex' as const, threadId: THREAD },
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: NOW
      },
      acquisitionGeneration: `generation-${fence}`
    }
  })
  releaseAcquisition = vi.fn(async () => true)
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      releaseAcquisition,
      dispatch,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length + 1}`,
    now: () => clock,
    setStartRetryTimer: (delayMs, run) => {
      const timer = { dueAt: clock + delayMs, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  host.subscribeStatus({
    id: 'list',
    emit: (event) => {
      if (event.type === 'status') {
        statusSessions.push(event.session.sessionId)
      }
    }
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function preSpawnRefusal(reason: AgentSessionPreSpawnReason): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(`refused: ${reason}`), { reason })
}

/** A new chat, its first start failing with `failure`. */
async function create(failure: unknown) {
  beforeSpawn.mockRejectedValueOnce(failure)
  return host.attach(CALLER, hostTestAttachParams(null, { providerHandle: undefined }))
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent).toMatchObject({ ok: true })
  return sent.ok ? sent.value.clientMessageId : ''
}

async function submission(clientMessageId: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

function child() {
  return host.collaboratorsForTests().sessions.get(SESSION)?.child ?? null
}

function bookedRetries() {
  return timers.filter((timer) => !timer.cancelled)
}

describe('a new chat whose first start fails', () => {
  it('stands at rest when the start is refused for now, and its first message waits, then goes', async () => {
    await expect(create(preSpawnRefusal('accountSwitchInProgress'))).resolves.toMatchObject({
      ok: true,
      replayed: false,
      fence: 2
    })
    // No child, so the first send starts one rather than writing to a child that is not there.
    expect(child()).toBeNull()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'released' })
    expect(statusSessions).toContain(SESSION)
    // Nothing in the chat says the create's start failed: the first message will.
    expect((await host.journalSnapshot(SESSION)).items).toEqual([])

    beforeSpawn.mockRejectedValueOnce(preSpawnRefusal('accountSwitchInProgress'))
    const first = await send('hello')
    await eventually(async () =>
      expect(await submission(first)).toMatchObject({
        dispatchState: 'pending',
        startRetry: { attempts: 1, rejection: agentSessionFailureFact('accountSwitchInProgress') }
      })
    )
    expect(bookedRetries()).toHaveLength(1)

    // The switch finished: the booked try starts the agent and hands it the message.
    const [timer] = bookedRetries()
    timer.cancelled = true
    clock = timer.dueAt
    timer.run()
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(child()).not.toBeNull()
    expect(acquire).toHaveBeenCalledTimes(3)
  })

  it('stands at rest when the agent is not installed, and its first message is rejected at once', async () => {
    await expect(create(preSpawnRefusal('providerMissing'))).resolves.toMatchObject({ ok: true })

    beforeSpawn.mockRejectedValueOnce(preSpawnRefusal('providerMissing'))
    const first = await send('hello')

    await eventually(async () =>
      expect(await submission(first)).toMatchObject({
        dispatchState: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('providerMissing'), {
          surface: 'rejection',
          agentName: 'Codex'
        })
      })
    )
    expect((await submission(first))?.reason).toContain("Codex isn't installed.")
    expect(bookedRetries()).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('stands at rest when the agent exited while starting, and its first message is rejected at once', async () => {
    const exited = () => withObservedProviderExit(new Error('codex exited during startup'))
    await expect(create(exited())).resolves.toMatchObject({ ok: true })
    expect(child()).toBeNull()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed' }
    })

    beforeSpawn.mockRejectedValueOnce(exited())
    const first = await send('hello')

    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    expect(bookedRetries()).toEqual([])
  })

  it('answers a replay of its create again, and starts nothing', async () => {
    const params = hostTestAttachParams(null, { providerHandle: undefined })
    beforeSpawn.mockRejectedValueOnce(preSpawnRefusal('accountSwitchInProgress'))
    await expect(host.attach(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: false })

    await expect(host.attach(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      fence: 2
    })
    expect(acquire).toHaveBeenCalledOnce()
    expect(child()).toBeNull()
  })

  it('is still refused when the start could not prove its process gone', async () => {
    releaseAcquisition.mockResolvedValueOnce(false)

    await expect(create(new Error('hung while starting'))).rejects.toThrow(
      AgentSessionAcquisitionExitUnprovenError
    )
    expect(child()).toBeNull()
  })
})

describe("an orchestration worker's chat whose agent is not installed", () => {
  it('is created, and its preamble is reported undelivered with the reason', async () => {
    await expect(create(preSpawnRefusal('providerMissing'))).resolves.toMatchObject({ ok: true })
    // The preamble's operation id is minted from the wall clock.
    clock = Date.now()
    beforeSpawn.mockRejectedValueOnce(preSpawnRefusal('providerMissing'))

    const error = await sendStructuredWorkerPreamble({
      host,
      sessionId: SESSION,
      dispatchId: 'dispatch-1',
      preamble: 'spec'
    }).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'dispatch_preamble_undelivered' })
    expect((error as Error).message).toContain("Codex isn't installed.")
  })
})

describe('a start of a chat that already exists, failing the same way', () => {
  it('is refused as before: only a create stands at rest', async () => {
    await expect(create(preSpawnRefusal('accountSwitchInProgress'))).resolves.toMatchObject({
      ok: true
    })
    beforeSpawn.mockRejectedValueOnce(preSpawnRefusal('accountSwitchInProgress'))

    await expect(host.attach(CALLER, hostTestAttachParams(2))).rejects.toThrow(
      AgentSessionPreSpawnError
    )
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    expect(child()).toBeNull()
  })
})
