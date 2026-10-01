// A start a queued message waited on can be seen failing twice: by the delivery loop, when the
// adapter settles the start without proving it, and by the exit settlement, when the child's exit
// lands. The loop is the one writer: it records the failure on the message the start was for, and
// on any message handed to that start's child, which took nothing. The message waits for its next
// try while later ones go on, and after the last try it is rejected in the same words.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { isStructuredAgentSessionStartFailureRow } from '../../../shared/structured-agent-session-start-failure-row-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  structuredAgentSessionCommandTurn,
  structuredAgentSessionCompactBody
} from './structured-agent-session-command-turn'
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
// A start that may land later without the person: an account switch still settling.
const TRANSIENT = agentSessionFailureFact('accountSwitchInProgress')
const TRANSIENT_WORDS = agentSessionFailureWords(TRANSIENT, {
  surface: 'rejection',
  agentName: 'Codex'
})
// A start that faulted at a dispatch: no exit was observed, so nothing blames the provider.
const DISPATCH_FAULT = agentSessionFailureFact('startFailed')
const DISPATCH_ERROR = `no live claude stream-json session for ${SESSION}`

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let generation = 0
let clock = NOW
let timers: { dueAt: number; run: () => void; cancelled: boolean }[] = []
let settleStart: (failure: SubmissionRejectionFact | undefined) => void = () => {}
let awaitStarted = vi.fn<() => Promise<SubmissionRejectionFact | undefined>>()
let dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
let compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>()
let closeSession = vi.fn<NonNullable<StructuredAgentSessionAdapter['closeSession']>>()
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

function startHost(): void {
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
      closeSession,
      dispatch,
      compact,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${generation + 1}`,
    now: () => clock,
    setStartRetryTimer: (delayMs, run) => {
      const timer = { dueAt: clock + delayMs, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
}

/** Moves the clock to the booked retry and lets it fire, as its timer would. */
async function fireRetry(): Promise<void> {
  await eventually(() => expect(timers.some((entry) => !entry.cancelled)).toBe(true))
  const timer = timers.findLast((entry) => !entry.cancelled)
  if (!timer) {
    throw new Error('no retry is booked')
  }
  timer.cancelled = true
  clock = timer.dueAt
  timer.run()
}

async function send(body: AgentJournalMessageItem): Promise<string> {
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

/** Sent while the loop waits on a start it made for the first message. */
async function sendQueued(text: string): Promise<string> {
  const id = await send(hostTestMessage(text))
  await eventually(() => expect(awaitStarted).toHaveBeenCalled())
  return id
}

async function submission(clientMessageId: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function startRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    isStructuredAgentSessionStartFailureRow(item.itemId) ? [item.itemId] : []
  )
}

/** Every failed start a subscriber was told for one message, in order. */
function framedStartFailures(clientMessageId: string): unknown[] {
  return frames.flatMap((frame) =>
    frame.type === 'batch'
      ? frame.batch.submissions.flatMap((entry) =>
          entry.clientMessageId === clientMessageId && entry.startFailure
            ? [entry.startFailure]
            : []
        )
      : []
  )
}

/** Every dispatch state a subscriber was told for one message, in order. */
function framedStates(clientMessageId: string): string[] {
  return frames.flatMap((frame) =>
    frame.type === 'batch'
      ? frame.batch.submissions
          .filter((entry) => entry.clientMessageId === clientMessageId)
          .map((entry) => entry.dispatchState)
      : []
  )
}

async function restartHostAndOpen(): Promise<void> {
  await host.flushAllStreamedEvents()
  startHost()
  await host.journalSnapshot(SESSION)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-failure-writer-'))
  resetHostTestOperationIds()
  generation = 0
  clock = NOW
  timers = []
  frames = []
  awaitStarted = vi.fn(
    () => new Promise<SubmissionRejectionFact | undefined>((resolve) => (settleStart = resolve))
  )
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  compact = vi.fn(async () => ({ state: 'admitted' as const }))
  closeSession = vi.fn(async () => true)
  store = await openTestAgentSessionRecordStore(root)
  startHost()
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
    ok: true
  })
  // The first child (generation-1) is lost at setup; the first send starts generation-2.
  await exitBeforeProof()
  await host.subscribe({ id: 'pane', sessionId: SESSION, emit: (event) => frames.push(event) })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a queued message whose start fails', () => {
  it('waits for its next try with the failure on it, and writes no row of its own', async () => {
    const queued = await sendQueued('hello')

    settleStart(TRANSIENT)
    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'pending',
        startFailure: {
          attempts: 1,
          reason: TRANSIENT_WORDS.reason,
          rejection: TRANSIENT,
          generation: 'generation-2',
          nextAttemptAt: NOW + 15_000
        }
      })
    )
    expect((await submission(queued))?.handedOverAt).toBeUndefined()
    expect(await startRows()).toEqual([])
    // The adapter ends a start it settled unproven; the loop waits for that end.
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('ends a failed child still there when the next try comes due, and starts afresh', async () => {
    const queued = await sendQueued('hello')
    settleStart(TRANSIENT)
    await eventually(async () =>
      expect((await submission(queued))?.startFailure).toMatchObject({ attempts: 1 })
    )
    awaitStarted.mockImplementation(async () => undefined)

    await fireRetry()

    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([queued])
    )
    expect(closeSession).toHaveBeenCalledOnce()
    expect(generation).toBe(3)
  })

  it('is tried again at 15 s, 1 min and 5 min, then rejected with the last failure', async () => {
    awaitStarted.mockImplementation(async () => TRANSIENT)
    const queued = await send(hostTestMessage('hello'))

    const booked: number[] = []
    for (const expected of [NOW + 15_000, NOW + 75_000, NOW + 375_000]) {
      await eventually(async () =>
        expect((await submission(queued))?.startFailure?.nextAttemptAt).toBe(expected)
      )
      booked.push(expected)
      await fireRetry()
    }

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...TRANSIENT_WORDS
      })
    )
    expect((await submission(queued))?.startFailure).toBeUndefined()
    expect(booked).toEqual([NOW + 15_000, NOW + 75_000, NOW + 375_000])
    // generation-1 at setup, then one start per try.
    expect(generation).toBe(5)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['signed out', agentSessionFailureFact('notSignedIn')],
    ['a launch setting to fix', agentSessionFailureFact('managedAccountEnvOverride')],
    [
      'a host that cannot run the chat',
      agentSessionFailureFact('restartFailed', {
        refusal: {
          code: 'structured_agent_session_unsupported',
          details: { reason: 'hostUnsupported' }
        }
      })
    ]
  ])('is rejected at once, with no try booked, when %s', async (_situation, failure) => {
    awaitStarted.mockImplementation(async () => failure)
    const queued = await send(hostTestMessage('hello'))

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...agentSessionFailureWords(failure, { surface: 'rejection', agentName: 'Codex' })
      })
    )
    expect(framedStartFailures(queued)).toEqual([])
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
  })

  it('is rejected at once when its own words send the person to a new chat', async () => {
    const historyTooLarge = agentSessionFailureFact('historyTooLarge')
    awaitStarted.mockImplementation(async () => historyTooLarge)
    const queued = await send(hostTestMessage('hello'))

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        rejection: historyTooLarge
      })
    )
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
  })

  it('lets a later message go first while it waits, then goes itself when its try is due', async () => {
    const first = await sendQueued('first')
    const second = await send(hostTestMessage('second'))
    awaitStarted.mockImplementation(async () => undefined)

    settleStart(TRANSIENT)
    await eventually(async () => expect((await submission(first))?.startFailure).toBeDefined())
    // The adapter ends the start it settled unproven.
    await exitBeforeProof()
    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([second])
    )
    expect(await submission(first)).toMatchObject({
      dispatchState: 'pending',
      startFailure: { attempts: 1 }
    })
    expect((await submission(first))?.handedOverAt).toBeUndefined()

    await fireRetry()
    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([second, first])
    )
    expect((await submission(first))?.startFailure).toBeUndefined()
  })
})

describe('a start that fails while its child exits', () => {
  it('is recorded once when the exit lands before the loop sees the start fail', async () => {
    const queued = await sendQueued('hello')

    await exitBeforeProof()
    expect(await submission(queued)).toMatchObject({ dispatchState: 'pending' })
    expect((await submission(queued))?.startFailure).toBeUndefined()
    settleStart(undefined)
    await eventually(async () =>
      expect((await submission(queued))?.startFailure).toMatchObject({ attempts: 1 })
    )
    await host.flushStreamedEvents(SESSION)

    expect((await submission(queued))?.startFailure?.attempts).toBe(1)
    expect(await startRows()).toEqual([])
  })

  it('is recorded once when the exit lands after the loop recorded it', async () => {
    const queued = await sendQueued('hello')

    settleStart(TRANSIENT)
    await eventually(async () =>
      expect((await submission(queued))?.startFailure).toMatchObject({ attempts: 1 })
    )
    await exitBeforeProof()
    await host.flushStreamedEvents(SESSION)

    expect(await submission(queued)).toMatchObject({
      dispatchState: 'pending',
      startFailure: { attempts: 1, reason: TRANSIENT_WORDS.reason }
    })
    expect(await startRows()).toEqual([])
  })

  it('puts a message its unproven child was handed back in the queue, never rejected by the exit', async () => {
    awaitStarted.mockImplementation(async () => undefined)
    const handed = await send(hostTestMessage('hello'))
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(await submission(handed)).toMatchObject({
      dispatchState: 'pending',
      handedOverAt: expect.any(Number)
    })

    await exitBeforeProof()

    await eventually(async () =>
      expect(await submission(handed)).toMatchObject({
        dispatchState: 'pending',
        startFailure: { attempts: 1, generation: 'generation-2' }
      })
    )
    expect((await submission(handed))?.handedOverAt).toBeUndefined()
    // Never rejected, nor in doubt, on the way: the exit wrote nothing about it.
    expect(framedStates(handed)).not.toContain('rejected')
    expect(framedStates(handed)).not.toContain('unknown')
  })
})

// H2d: the child took one message, then could not take the next, and its exit never lands (Orca
// quit or restarted first). The loop is the only one to see that start fail.
describe('a start whose child took one message and cannot take the next', () => {
  it('ends the child and puts both back in the queue, then a restart fails them with that start', async () => {
    awaitStarted.mockImplementation(async () => undefined)
    dispatch.mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    dispatch.mockImplementation(() => {
      throw new Error(DISPATCH_ERROR)
    })
    const first = await sendQueued('first')
    const second = await send(hostTestMessage('second'))

    await eventually(async () =>
      expect((await submission(second))?.startFailure).toMatchObject({ attempts: 1 })
    )
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(closeSession).toHaveBeenCalled()
    const words = agentSessionFailureWords(DISPATCH_FAULT, {
      surface: 'rejection',
      agentName: 'Codex'
    })
    for (const id of [first, second]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'pending',
        startFailure: { attempts: 1, generation: 'generation-2', reason: words.reason }
      })
      expect((await submission(id))?.handedOverAt).toBeUndefined()
      // Never in doubt on the way: the child it was handed to took nothing.
      expect(framedStates(id)).not.toContain('unknown')
    }

    await restartHostAndOpen()

    for (const id of [first, second]) {
      await eventually(async () =>
        expect(await submission(id)).toMatchObject({ dispatchState: 'rejected', ...words })
      )
    }
  })
})

describe('a /compact whose start fails at its handover', () => {
  it('ends its turn and says to run /compact again, from its own body', async () => {
    // An older plain message waits out its own failed start; the /compact goes on past it.
    const plain = await sendQueued('first')
    settleStart(TRANSIENT)
    await eventually(async () =>
      expect((await submission(plain))?.startFailure).toMatchObject({ attempts: 1 })
    )
    await exitBeforeProof()
    awaitStarted.mockImplementation(async () => undefined)
    compact.mockImplementation(() => {
      throw new Error(DISPATCH_ERROR)
    })

    const command = await send(structuredAgentSessionCompactBody())

    await eventually(async () =>
      expect((await submission(command))?.startFailure).toMatchObject({ attempts: 1 })
    )
    expect(compact).toHaveBeenCalledOnce()
    expect((await submission(command))?.startFailure?.reason).toBe(
      agentSessionFailureWords(DISPATCH_FAULT, {
        surface: 'rejection',
        agentName: 'Codex',
        command: 'compact'
      }).reason
    )
    expect((await submission(plain))?.startFailure?.reason).toBe(TRANSIENT_WORDS.reason)
    const turn = (await host.journalSnapshot(SESSION)).items.find(
      (item) => item.itemId === structuredAgentSessionCommandTurn(command).itemId
    )
    expect(turn?.body).toMatchObject({ kind: 'turn', state: 'completed', outcome: 'failure' })
  })
})

describe('a message waiting for its next try when it can wait no longer', () => {
  async function retrying(): Promise<string> {
    const queued = await sendQueued('hello')
    settleStart(TRANSIENT)
    await eventually(async () =>
      expect((await submission(queued))?.startFailure).toMatchObject({ attempts: 1 })
    )
    return queued
  }

  it('reads as failed with its own failure when the chat closes', async () => {
    const queued = await retrying()

    await host.close(SESSION, 'user-close')

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...TRANSIENT_WORDS
      })
    )
  })

  it('reads as failed with its own failure when Orca restarts', async () => {
    const queued = await retrying()

    await restartHostAndOpen()

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...TRANSIENT_WORDS
      })
    )
  })

  it('is withdrawn by a Stop, as any queued message is', async () => {
    const queued = await retrying()

    await host.cancel(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: SESSION,
          fields: {}
        })
      }
    })

    expect(await submission(queued)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'cancelled' }
    })
  })
})

describe('what waits on a message whose start failed', () => {
  it('is answered at the first failure: the send waits for nothing more', async () => {
    const queued = await sendQueued('hello')
    const handedOver = host.waitForSendSettlement(SESSION, queued, {
      until: 'handed-over',
      budgetMs: 5_000
    })
    const answered = host.waitForSendSettlement(SESSION, queued, { budgetMs: 5_000 })

    settleStart(TRANSIENT)

    for (const settled of [await handedOver, await answered]) {
      expect(settled?.value).toMatchObject({
        submission: { dispatchState: 'pending', startFailure: { attempts: 1 } }
      })
    }
  })

  it('reads as failed, not working, in every session list while it waits', async () => {
    const statuses: { status: unknown; turnOutcome?: unknown }[] = []
    host.subscribeStatus({
      id: 'list-1',
      emit: (event) => {
        if (event.type === 'status' && event.session.sessionId === SESSION) {
          statuses.push(event.session)
        }
      }
    })
    const queued = await sendQueued('hello')

    settleStart(TRANSIENT)
    await eventually(async () =>
      expect((await submission(queued))?.startFailure).toMatchObject({ attempts: 1 })
    )

    await eventually(() =>
      expect(statuses.at(-1)).toMatchObject({ status: 'idle', turnOutcome: 'failure' })
    )
  })
})
