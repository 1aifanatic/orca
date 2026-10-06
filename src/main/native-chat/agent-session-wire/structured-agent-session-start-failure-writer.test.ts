// A start that fails fails only the message it was for, and the messages behind it each get their
// own start. Three writers settle a failed start, one per state the message is in: the delivery
// loop the queued message the start was for, the handover the message being handed over, and the
// exit any message handed to a child that never proved its start. Every write names a message fixed
// when its pass chose it, so a failure on the way never lands on another message.

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
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { isStructuredAgentSessionStartFailureRow } from '../../../shared/structured-agent-session-start-failure-row-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { ResolveDispatchInput } from '../agent-session-journal/journal-store-contracts'
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
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'
// A situation that could clear on its own, seen after the child was spawned.
const TRANSIENT = agentSessionFailureFact('accountSwitchInProgress')
const TRANSIENT_WORDS = agentSessionFailureWords(TRANSIENT, {
  surface: 'rejection',
  agentName: 'Codex'
})
// A start that faulted at a dispatch: no exit was observed, so nothing blames the provider.
const DISPATCH_FAULT = agentSessionFailureFact('startFailed')
const DISPATCH_WORDS = agentSessionFailureWords(DISPATCH_FAULT, {
  surface: 'rejection',
  agentName: 'Codex'
})
// A child that ran and could not finish its start.
const PROVIDER_START_FAILED = agentSessionFailureFact('providerStartFailed')
const HOST_FAULT_WORDS = agentSessionFailureWords(agentSessionFailureFact('hostFault'), {
  surface: 'rejection'
})

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>
let generation = 0
let settleStart: (failure: SubmissionRejectionFact | undefined) => void = () => {}
// Runs before each spawn; throwing refuses that start before it ran.
let beforeSpawn = vi.fn<() => Promise<void>>()
let awaitStarted = vi.fn<() => Promise<SubmissionRejectionFact | undefined>>()
let dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
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
    agents: NO_STRUCTURED_AGENTS,
    logger: log.logger,
    store,
    adapter: {
      acquire: vi.fn(async ({ fence, spawnToken }) => {
        await beforeSpawn()
        return {
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken
          },
          link: {
            linkId: `link-${fence}`,
            handle: codexProviderHandle(THREAD),
            origin: generation === 0 ? ('created' as const) : ('resumed' as const),
            mintedAtFence: fence,
            observedAt: NOW
          },
          acquisitionGeneration: `generation-${++generation}`,
          providerChildPhase: 'starting' as const
        }
      }),
      awaitStarted,
      releaseAcquisition: vi.fn(async () => true),
      closeSession,
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

/** Sent while the loop waits on a start it made for the first message. */
async function sendQueued(text: string): Promise<string> {
  const id = await send(text)
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

function dispatched(): string[] {
  return dispatch.mock.calls.map(([input]) => input.clientMessageId)
}

/** Records each rejection the journal is asked to write, in order; with `fail`, fails that
 *  message's first `times` (one by default), before they land or after. */
function spyRejections(fail?: {
  clientMessageId: string
  when: 'before' | 'after'
  times?: number
}): string[] {
  const order: string[] = []
  const resolve = AgentSessionJournal.prototype.resolveDispatch
  let failures = 0
  vi.spyOn(AgentSessionJournal.prototype, 'resolveDispatch').mockImplementation(async function (
    this: AgentSessionJournal,
    input: ResolveDispatchInput
  ) {
    if (input.state === 'rejected') {
      order.push(`rejected ${input.clientMessageId}`)
    }
    if (
      failures >= (fail?.times ?? 1) ||
      input.state !== 'rejected' ||
      input.clientMessageId !== fail?.clientMessageId
    ) {
      return resolve.call(this, input)
    }
    failures += 1
    if (fail.when === 'after') {
      await resolve.call(this, input)
    }
    throw new Error('journal write failed')
  })
  return order
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-failure-writer-'))
  resetHostTestOperationIds()
  generation = 0
  frames = []
  log = recordingStructuredAgentSessionLogger()
  beforeSpawn = vi.fn(async () => undefined)
  awaitStarted = vi.fn(
    () => new Promise<SubmissionRejectionFact | undefined>((resolve) => (settleStart = resolve))
  )
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
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
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a queued message whose start fails', () => {
  it('is rejected at once for any failure after its child was spawned, whatever the failure', async () => {
    const queued = await sendQueued('hello')

    settleStart(TRANSIENT)

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...TRANSIENT_WORDS
      })
    )
    expect(await startRows()).toEqual([])
  })

  it('fails only itself: each message behind it gets its own start', async () => {
    beforeSpawn.mockImplementationOnce(async () => {
      throw new AgentSessionPreSpawnError(new Error('spawn codex ENOENT'))
    })
    awaitStarted.mockImplementation(async () => undefined)
    const first = await send('first')
    const second = await send('second')
    const third = await send('third')

    await eventually(() => expect(dispatched()).toEqual([second, third]))
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'restartFailed' }
    })
    for (const id of [second, third]) {
      expect(framedStates(id)).not.toContain('rejected')
    }
    expect(await startRows()).toEqual([])
  })

  it('ends a failed child still there when the next message comes, and starts afresh', async () => {
    const failed = await sendQueued('first')
    settleStart(PROVIDER_START_FAILED)
    await eventually(async () =>
      expect(await submission(failed)).toMatchObject({ dispatchState: 'rejected' })
    )
    // Not ended at once: an exit of its own may already be on its way.
    expect(closeSession).not.toHaveBeenCalled()
    awaitStarted.mockImplementation(async () => undefined)

    const next = await send('second')

    await eventually(() => expect(dispatched()).toEqual([next]))
    expect(closeSession).toHaveBeenCalledOnce()
    expect(generation).toBe(3)
  })
})

describe('a failure on the way to recording a failed start', () => {
  it('retries the same message when the rejection did not land, and never fails the one behind it', async () => {
    const first = await sendQueued('first')
    const second = await send('second')
    spyRejections({ clientMessageId: first, when: 'before' })
    awaitStarted.mockImplementation(async () => undefined)

    settleStart(DISPATCH_FAULT)

    // The catch's retry is Orca's fault, worded as one; the message behind it goes on.
    await eventually(async () =>
      expect(await submission(first)).toMatchObject({
        dispatchState: 'rejected',
        ...HOST_FAULT_WORDS
      })
    )
    await eventually(() => expect(dispatched()).toEqual([second]))
    expect(framedStates(second)).not.toContain('rejected')
  })

  it('never fails the message behind one whose rejection landed before the error', async () => {
    const first = await sendQueued('first')
    const second = await send('second')
    spyRejections({ clientMessageId: first, when: 'after' })
    awaitStarted.mockImplementation(async () => undefined)

    settleStart(DISPATCH_FAULT)

    await eventually(async () =>
      expect(await submission(first)).toMatchObject({
        dispatchState: 'rejected',
        ...DISPATCH_WORDS
      })
    )
    await eventually(() => expect(dispatched()).toEqual([second]))
    expect(framedStates(second)).not.toContain('rejected')
    expect(log.entries.map((entry) => entry.fields.scope)).toContain('delivery-loop')
  })

  it('records the failure before ending the failed child, so a failed cleanup loses nothing', async () => {
    const first = await sendQueued('first')
    const second = await send('second')
    const order = spyRejections()
    closeSession.mockImplementation(async () => {
      order.push('cleanup')
      throw new Error('stop failed')
    })

    settleStart(DISPATCH_FAULT)

    await eventually(async () =>
      expect(await submission(second)).toMatchObject({ dispatchState: 'rejected' })
    )
    expect(order.slice(0, 2)).toEqual([`rejected ${first}`, 'cleanup'])
    expect(await submission(first)).toMatchObject({ dispatchState: 'rejected', ...DISPATCH_WORDS })
    expect(log.entries.map((entry) => entry.fields.scope)).toContain(
      'delivery-loop-end-failed-start'
    )
    // The stop could not prove the exit, so the next start is refused for that, in its own words.
    expect(await submission(second)).toMatchObject({
      rejection: {
        kind: 'restartFailed',
        refusal: { details: { reason: 'previousExitUnverifiable' } }
      }
    })
    expect(dispatch).not.toHaveBeenCalled()
    // Quit's own stop of the old child succeeds.
    closeSession.mockImplementation(async () => true)
  })
})

describe('a start that fails while its child exits', () => {
  // Neither the loop nor its catch could record the failure, so the message stayed queued.
  it('records the start on the message it was for when its child ends, rather than starting again', async () => {
    const queued = await sendQueued('hello')
    spyRejections({ clientMessageId: queued, when: 'before', times: 2 })

    settleStart(DISPATCH_FAULT)
    await eventually(() =>
      expect(log.entries.map((entry) => entry.fields.scope)).toContain('delivery-loop-fail')
    )
    expect(await submission(queued)).toMatchObject({ dispatchState: 'pending' })
    await exitBeforeProof()

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    )
    expect(generation).toBe(2)
    expect(await startRows()).toEqual([])
  })

  it('is recorded once when the exit lands before the loop sees the start fail', async () => {
    const queued = await sendQueued('hello')

    await exitBeforeProof()
    expect(await submission(queued)).toMatchObject({ dispatchState: 'pending' })
    settleStart(undefined)
    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    )
    const recorded = await submission(queued)
    await host.flushStreamedEvents(SESSION)

    expect(await submission(queued)).toEqual(recorded)
    expect(await startRows()).toEqual([])
  })

  it('is recorded once when the exit lands after the loop recorded it', async () => {
    const queued = await sendQueued('hello')

    settleStart(DISPATCH_FAULT)
    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...DISPATCH_WORDS
      })
    )
    const recorded = await submission(queued)
    await exitBeforeProof()
    await host.flushStreamedEvents(SESSION)

    // The exit's own reason never rewrites the failure the loop recorded.
    expect(await submission(queued)).toEqual(recorded)
    expect(await startRows()).toEqual([])
  })

  it('rejects a message its unproven child was handed with the start, never in doubt', async () => {
    awaitStarted.mockImplementation(async () => undefined)
    const handed = await send('hello')
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(await submission(handed)).toMatchObject({
      dispatchState: 'pending',
      handedOverAt: expect.any(Number)
    })

    await exitBeforeProof()

    await eventually(async () =>
      expect(await submission(handed)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    )
    // Never in doubt on the way: the child it was handed to took nothing.
    expect(framedStates(handed)).not.toContain('unknown')
    expect(await startRows()).toEqual([])
  })
})
