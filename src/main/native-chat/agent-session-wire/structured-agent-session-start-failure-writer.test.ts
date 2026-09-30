// A start a queued message waited on can be seen failing twice: by the delivery loop, when the
// adapter settles the start without proving it or cannot take the message it was handed, and by
// the exit settlement, when the child's exit lands. Both key the start by the child's generation, so
// the chat gets one row for it, in the words every message it was for was rejected with. The exit
// writes it only when it rejected a message handed to the child and no row is there yet; else the
// loop does.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
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

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'
const ADAPTER_FAILURE = agentSessionFailureFact('notSignedIn')
const ADAPTER_FAILURE_TEXT =
  'Codex is not signed in for the selected account. Sign in, then send your message again.'
// The exit's reason is Orca's log text; the row says only that the start stopped.
const EXIT_TEXT = 'Codex stopped before it finished starting. Send your message to try again.'
// The first child (generation-1) is lost at setup; the send starts generation-2.
const START_ROW = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'start-failure:generation-2'
})

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let generation = 0
let settleStart: (failure: SubmissionRejectionFact | undefined) => void = () => {}
let awaitStarted = vi.fn<() => Promise<SubmissionRejectionFact | undefined>>()
let dispatch = vi.fn<() => Promise<{ state: 'admitted' }>>()
let frames: AgentSessionSubscribeEvent[] = []

function exitBeforeProof(): Promise<void> {
  return host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: `generation-${generation}`,
    reason: EXIT_REASON,
    cause: 'unexpected-exit',
    startupUnproven: true
  })
}

async function sendQueued(text: string): Promise<string> {
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
  // The loop started a child and waits on its start with the message still queued.
  await eventually(() => expect(awaitStarted).toHaveBeenCalledOnce())
  expect(generation).toBe(2)
  return sent.ok ? sent.value.clientMessageId : ''
}

async function submission(clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

/** Every text the subscriber was sent for the start's row, in order. */
function publishedStartRows(): string[] {
  return frames.flatMap((frame) =>
    frame.type === 'batch'
      ? frame.batch.items.flatMap((item) =>
          item.itemId === START_ROW && item.body.kind === 'status' ? [item.body.text] : []
        )
      : []
  )
}

async function startRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.itemId === START_ROW && item.body.kind === 'status' ? [item.body.text] : []
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-failure-writer-'))
  resetHostTestOperationIds()
  generation = 0
  frames = []
  awaitStarted = vi.fn(
    () => new Promise<SubmissionRejectionFact | undefined>((resolve) => (settleStart = resolve))
  )
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: vi.fn(async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex' as const, threadId: THREAD },
          origin: generation === 0 ? ('created' as const) : ('resumed' as const),
          mintedAtFence: fence,
          observedAt: NOW
        },
        acquisitionGeneration: `generation-${++generation}`,
        providerChildPhase: 'starting' as const
      })),
      awaitStarted,
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${generation + 1}`,
    now: () => NOW
  })
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
    ok: true
  })
  await exitBeforeProof()
  await host.subscribe({ id: 'pane', sessionId: SESSION, emit: (event) => frames.push(event) })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a queued message whose start fails and whose child then exits', () => {
  it("keeps the loop's row when the loop saw the failure first", async () => {
    const queued = await sendQueued('hello')

    settleStart(ADAPTER_FAILURE)
    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        reason: ADAPTER_FAILURE_TEXT,
        rejection: ADAPTER_FAILURE
      })
    )
    await exitBeforeProof()
    await host.flushStreamedEvents(SESSION)

    expect(await startRows()).toEqual([ADAPTER_FAILURE_TEXT])
    expect(publishedStartRows()).toEqual([ADAPTER_FAILURE_TEXT])
  })

  it('leaves the row to the loop when the exit lands while the message still waits', async () => {
    const queued = await sendQueued('hello')

    await exitBeforeProof()
    expect(await submission(queued)).toMatchObject({ dispatchState: 'pending' })
    settleStart(undefined)
    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({ dispatchState: 'rejected' })
    )
    await host.flushStreamedEvents(SESSION)

    expect(await startRows()).toEqual([EXIT_TEXT])
    // Written once, after the message was settled, not first by the exit and again by the loop.
    expect(publishedStartRows()).toEqual([EXIT_TEXT])
  })
})

// The adapter's session is gone before the host has seen the exit: the start settles with no
// reason, and the child the host still holds as starting cannot take the message handed to it.
describe('a start whose child cannot take the message it was handed', () => {
  it('rejects every message it was for with the one row the exit then leaves alone', async () => {
    const first = await sendQueued('first')
    const second = await sendQueued('second')
    dispatch.mockImplementation(() => {
      throw new Error(`no live claude stream-json session for ${SESSION}`)
    })
    awaitStarted.mockImplementation(async () => undefined)

    settleStart(undefined)
    await eventually(async () => {
      expect(await submission(first)).toMatchObject({ dispatchState: 'rejected' })
      expect(await submission(second)).toMatchObject({ dispatchState: 'rejected' })
    })
    await exitBeforeProof()
    await host.flushStreamedEvents(SESSION)

    const row = (await host.journalSnapshot(SESSION)).items.find(
      (item) => item.itemId === START_ROW
    )
    const firstRejected = await submission(first)
    const secondRejected = await submission(second)
    // Nothing saw the provider stop when the handover failed; each message names the start the row
    // is keyed by.
    expect(firstRejected).toMatchObject({
      rejection: { kind: 'startFailed' },
      rejectedByStartKey: 'generation-2'
    })
    expect(row?.body).toEqual({
      kind: 'status',
      text: firstRejected?.reason,
      tone: 'error',
      failure: firstRejected?.rejection
    })
    expect(secondRejected).toMatchObject({
      reason: firstRejected?.reason,
      rejection: firstRejected?.rejection,
      rejectedByStartKey: 'generation-2'
    })
    expect(publishedStartRows()).toEqual([firstRejected?.reason])
    // One start failed, so one handover tried it.
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
