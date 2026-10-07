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
import type {
  AgentSessionSubscribeEvent,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import {
  isStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRowIdentity
} from '../../../shared/structured-agent-session-start-failure-row-key'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalLifecycleBatchInput } from '../agent-session-journal/journal-store-contracts'
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
const SETUP_FAILURE = agentSessionFailureFact('managedAccountUnsupported')
const SETUP_ROW = agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-1'))
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

function exitBeforeProof(failure?: SubmissionRejectionFact): Promise<void> {
  return host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: `generation-${generation}`,
    reason: EXIT_REASON,
    cause: 'unexpected-exit',
    startupUnproven: true,
    ...(failure ? { failure } : {})
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

/** The start-failure rows written since setup, whose own failed start (generation-1) left one. */
async function startRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    isStructuredAgentSessionStartFailureRow(item.itemId) && item.itemId !== SETUP_ROW
      ? [item.itemId]
      : []
  )
}

/** The row a failed start leaves for the message it was for. */
function rowFor(clientMessageId: string): string {
  return agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(clientMessageId))
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

/** Records each failed start's write the journal is asked for, in order; with `fail`, fails that
 *  message's first `times` (one by default), before they land or after. */
function spyRejections(fail?: {
  clientMessageId: string
  when: 'before' | 'after'
  times?: number
}): string[] {
  const order: string[] = []
  const append = AgentSessionJournal.prototype.appendLifecycleBatch
  let failures = 0
  vi.spyOn(AgentSessionJournal.prototype, 'appendLifecycleBatch').mockImplementation(
    async function (this: AgentSessionJournal, input: JournalLifecycleBatchInput) {
      const rejected = input.rejects?.clientMessageId
      if (rejected !== undefined) {
        order.push(`rejected ${rejected}`)
      }
      if (
        failures >= (fail?.times ?? 1) ||
        rejected === undefined ||
        rejected !== fail?.clientMessageId
      ) {
        return append.call(this, input)
      }
      failures += 1
      if (fail.when === 'after') {
        await append.call(this, input)
      }
      throw new Error('journal write failed')
    }
  )
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
  // The first child (generation-1) is lost at setup; the first send starts generation-2. Its row
  // states another failure, so it never speaks for a test's own failed start.
  await exitBeforeProof(SETUP_FAILURE)
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
    expect(await startRows()).toEqual([rowFor(queued)])
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
    // One row per failed start: the first's, and none for the messages that went on.
    expect(await startRows()).toEqual([rowFor(first)])
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
    expect(await startRows()).toEqual([rowFor(queued)])
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
    expect(await startRows()).toEqual([rowFor(queued)])
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
    expect(await startRows()).toEqual([rowFor(queued)])
  })

  // A message queued behind it waits on the same start; the exit still writes the handed one's row.
  it('gives a handed message its row though a message is queued behind it on the same start', async () => {
    awaitStarted.mockImplementationOnce(async () => undefined)
    const handed = await send('handed')
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    const queued = await send('queued')
    // The next pass waits on the same child's start for the queued message.
    await eventually(() => expect(awaitStarted).toHaveBeenCalledTimes(2))

    await exitBeforeProof()
    settleStart(undefined)

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({ dispatchState: 'rejected' })
    )
    for (const id of [handed, queued]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    }
    // The exit's row for the handed message; the queued one failed alike, so it reads under it.
    expect(await startRows()).toEqual([
      agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-2'))
    ])
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
    // The exit rejected it, so the exit writes the start's one row.
    expect(await startRows()).toEqual([
      agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-2'))
    ])
  })
})

// One row speaks for a run of starts that fail alike, until a turn is delivered. Each message still
// makes its own start and is rejected on its own; the run's row says why for all of them.
describe('a run of starts that fail alike', () => {
  const accepted: StructuredAgentSessionAdapter['dispatch'] = async () => ({
    state: 'accepted',
    providerIdentity: {
      provider: 'codex',
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  })

  const NOT_SIGNED_IN = agentSessionFailureFact('notSignedIn')

  it('writes one row when every start fails not signed in, each message making its own attempt', async () => {
    const completions: AgentSessionTurnCompletionEvent[] = []
    host.subscribeTurnCompletions({ id: 'dot', emit: (event) => completions.push(event) })
    const first = await sendQueued('first')
    const second = await send('second')
    const third = await send('third')
    awaitStarted.mockImplementation(async () => NOT_SIGNED_IN)

    settleStart(NOT_SIGNED_IN)

    await eventually(async () =>
      expect(await submission(third)).toMatchObject({ dispatchState: 'rejected' })
    )
    for (const id of [first, second, third]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        rejection: NOT_SIGNED_IN
      })
    }
    // Setup's child was generation-1; each message made its own start.
    expect(generation).toBe(4)
    expect(await startRows()).toEqual([rowFor(first)])
    await host.flushStreamedEvents(SESSION)
    expect(completions).toHaveLength(1)
    // A client that hides rejected messages reads the run's one row, as before.
    const snapshot = await host.journalSnapshot(SESSION)
    const row = snapshot.items.find((item) => item.itemId === rowFor(first))?.body
    const drawn = projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions, {
      rejectedInPlace: false
    })
    const texts = drawn.flatMap((message) =>
      message.blocks.flatMap((block) => ('text' in block ? [block.text] : []))
    )
    expect(row?.kind === 'status' ? texts.filter((text) => text === row.text) : []).toHaveLength(1)
    for (const id of [first, second, third]) {
      expect(drawn.map((message) => message.id)).not.toContain(agentJournalSubmissionKey(id))
    }
  })

  it('writes one row when a start fails once and the messages behind it are delivered', async () => {
    dispatch.mockImplementation(accepted)
    const first = await sendQueued('first')
    const second = await send('second')
    const third = await send('third')

    await exitBeforeProof()
    awaitStarted.mockImplementation(async () => undefined)
    settleStart(undefined)

    await eventually(() => expect(dispatched()).toEqual([second, third]))
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      rejection: PROVIDER_START_FAILED
    })
    for (const id of [second, third]) {
      expect(await submission(id)).toMatchObject({ dispatchState: 'accepted' })
    }
    expect(await startRows()).toEqual([rowFor(first)])
  })

  it('writes a row for each failure when the starts fail differently', async () => {
    const first = await sendQueued('first')
    const second = await send('second')
    awaitStarted.mockImplementation(async () => TRANSIENT)

    settleStart(DISPATCH_FAULT)

    await eventually(async () =>
      expect(await submission(second)).toMatchObject({
        dispatchState: 'rejected',
        ...TRANSIENT_WORDS
      })
    )
    expect(await startRows()).toEqual([rowFor(first), rowFor(second)])
  })

  it('writes a row again for a failure alike once a turn was delivered after the last row', async () => {
    dispatch.mockImplementation(accepted)
    const first = await sendQueued('first')
    awaitStarted.mockImplementationOnce(async () => undefined)
    settleStart(DISPATCH_FAULT)
    await eventually(async () =>
      expect(await submission(first)).toMatchObject({ dispatchState: 'rejected' })
    )
    const delivered = await send('delivered')
    await eventually(async () =>
      expect(await submission(delivered)).toMatchObject({ dispatchState: 'accepted' })
    )
    // The delivered turn's child proved its start and later ends, so the next message makes its own.
    const child = {
      sessionId: SESSION,
      fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      acquisitionGeneration: `generation-${generation}`
    }
    await host.handleAdapterEvent({
      type: 'started',
      ...child,
      reportedOptions: { model: 'gpt-5' },
      restoreSkippedOptions: []
    })
    await host.handleAdapterEvent({
      type: 'ended',
      ...child,
      reason: 'codex app-server exited',
      cause: 'unexpected-exit'
    })
    awaitStarted.mockImplementation(async () => DISPATCH_FAULT)

    const last = await send('last')

    await eventually(async () =>
      expect(await submission(last)).toMatchObject({ dispatchState: 'rejected', ...DISPATCH_WORDS })
    )
    expect(await startRows()).toEqual([rowFor(first), rowFor(last)])
  })

  // Codex's stderr is a log: its tracing stamps each line, so two exits alike differ in the time.
  it('writes one row for two startup exits whose stderr differs only by its timestamp', async () => {
    const stderr = (at: string) =>
      agentSessionFailureFact('providerExited', {
        detail: {
          text: `${at} ERROR codex_app_server: unknown field \`foo\` in config.toml`,
          audience: 'log'
        }
      })
    awaitStarted.mockImplementation(async () => undefined)
    const first = await send('first')
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    await exitBeforeProof(stderr('2026-10-07T01:02:03.456789Z'))
    await eventually(async () =>
      expect(await submission(first)).toMatchObject({ dispatchState: 'rejected' })
    )
    const second = await send('second')
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(2))

    await exitBeforeProof(stderr('2026-10-07T01:02:09.012345Z'))

    await eventually(async () =>
      expect(await submission(second)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'providerStartFailed', detail: { audience: 'log' } }
      })
    )
    expect(await startRows()).toEqual([
      agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-2'))
    ])
  })

  // Words written for a person name what failed: two that differ are two failures.
  it('writes a row for each of two refusals whose words for a person differ', async () => {
    const refused = (text: string) =>
      agentSessionFailureFact('providerStartFailed', { detail: { text, audience: 'person' } })
    const first = await sendQueued('first')
    const second = await send('second')
    awaitStarted.mockImplementation(async () => refused('no rollout found for thread id t-2'))

    settleStart(refused('no rollout found for thread id t-1'))

    await eventually(async () =>
      expect(await submission(second)).toMatchObject({ dispatchState: 'rejected' })
    )
    expect(await startRows()).toEqual([rowFor(first), rowFor(second)])
  })

  it("writes no row for an exit that fails alike its run's row, though it rejected the message", async () => {
    awaitStarted.mockImplementation(async () => undefined)
    const first = await send('first')
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    await exitBeforeProof()
    await eventually(async () =>
      expect(await submission(first)).toMatchObject({ dispatchState: 'rejected' })
    )
    const second = await send('second')
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(2))

    await exitBeforeProof()

    await eventually(async () =>
      expect(await submission(second)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    )
    expect(await startRows()).toEqual([
      agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-2'))
    ])
  })
})
