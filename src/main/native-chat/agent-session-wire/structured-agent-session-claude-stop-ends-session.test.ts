// A Stop ends Claude's child on the shipping adapter, whatever Claude answered the interrupt. The
// Stop answers on the interrupt; its next serialized step ends the child once the stopped turn ends
// or the grace runs out. The chat rests; the next send resumes it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import {
  ClaudeControlRequestError,
  runClaudeControl
} from '../../claude/claude-agent-sdk-control-requests'
import { CLAUDE_STOP_GRACE_MS } from '../../claude/claude-turn-end-wait'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from '../../claude/claude-structured-session-state'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
// As Claude Code 2.1.280 advertises them on a turn's system/init frame.
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let queued: string[]
let claude: ReturnType<typeof fakeClaude>
let events: ClaudeStructuredSessionEvent[]
let backgroundStates: unknown[]
let sinkErrors: unknown[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-stop-ends-session-'))
  resetHostTestOperationIds()
  queued = []
  events = []
  backgroundStates = []
  sinkErrors = []
  claude = fakeClaude({
    replayUuid: null,
    routes: {
      interrupt: (params) =>
        params?.cancelQueued
          ? { still_queued: [], cancelled: queued.splice(0) }
          : { still_queued: [...queued] }
    }
  })
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    onEvent: (event) => {
      events.push(event)
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onBackgroundTasksChanged: (_sessionId, state) => backgroundStates.push(state),
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    onEventSinkError: ({ error }) => sinkErrors.push(error),
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await adapter.awaitStarted(SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function envelope(
  method: 'agentSession.send' | 'agentSession.cancel',
  fields: Record<string, unknown>,
  fence = store.getRecord(SESSION)!.lease.runtimeFence
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function send(text: string, fence?: number): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }, fence),
    body
  })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  return sent.value.clientMessageId
}

async function dispatch(clientMessageId: string) {
  const submission = (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
  return { state: submission?.dispatchState, reason: submission?.reason }
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

/** Sends a message and lets Claude open its turn and write one reply; returns the turn's id. */
async function openTurn(connection: FakeConnection, text = 'Write a long reply.'): Promise<string> {
  const clientMessageId = await send(text)
  await eventually(() =>
    expect(connection.sent.some((message) => JSON.stringify(message).includes(text))).toBe(true)
  )
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: `init-${text}`,
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const written = connection.sent.at(-1)!
  frame(connection, { ...written, uuid: written.uuid })
  frame(connection, {
    type: 'assistant',
    uuid: 'stopped-turn-leaf',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working on' }] }
  })
  await eventually(async () => expect((await dispatch(clientMessageId)).state).toBe('accepted'))
  const turnId = activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
  expect(turnId).not.toBeNull()
  return turnId!
}

function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
}

/** Resolves once everything queued on the session's lane so far has run: a Stop's second step. */
function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

function wrote(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}

const INTERRUPTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  uuid: 'interrupted-result'
}

async function interruptSent(connection: FakeConnection): Promise<void> {
  await eventually(() =>
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  )
}

async function turnOutcome(): Promise<string | undefined> {
  await host.flushStreamedEvents(SESSION)
  const snapshot = await host.journalSnapshot(SESSION)
  return readAgentJournalTurn(snapshot.items.findLast((item) => item.body.kind === 'turn')?.body)
    ?.outcome
}

async function statusTexts(): Promise<string[]> {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [String(item.body.text)] : []
  )
}

it('answers on the interrupt, ends the child once the stopped turn ends, and rests at that turn', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  // The Stop answered on the interrupt Claude took: the child waits for Claude to end the turn.
  expect(connection.closed).toBe(false)
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  const ended = Date.now()
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  // The turn's own end releases the wait; the grace is not waited out.
  expect(Date.now() - ended).toBeLessThan(CLAUDE_STOP_GRACE_MS / 2)

  expect(connection.closed).toBe(true)
  expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  expect(await turnOutcome()).toBe('cancellation')
  // The resume point is the stopped turn's own, so the next send continues after it.
  expect(events.findLast((event) => event.type === 'handle')).toMatchObject({
    type: 'handle',
    providerSessionId: PROVIDER_SESSION_ID,
    leafUuid: 'stopped-turn-leaf'
  })
})

it('withdraws a follow-up Claude queued behind the turn before the child ends, never doubt', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const followUp = await send('And then this.')
  await eventually(() => expect(connection.sent.at(-1)?.message).toBeDefined())
  queued.push(String(connection.sent.at(-1)!.uuid))
  await eventually(async () => expect((await dispatch(followUp)).state).toBe('pending'))

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  // Withdrawn by Claude's own receipt while the child still runs, so it is never re-sent and never
  // read as delivered.
  expect(connection.closed).toBe(false)
  expect(await dispatch(followUp)).toEqual({
    state: 'rejected',
    reason: DISPATCH_REJECTED_CANCELLED
  })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(connection.closed).toBe(true)
})

it('ends the child at once when Claude refuses the interrupt, and says only that the stop was asked', async () => {
  claude.routes.interrupt = () => {
    throw new ClaudeControlRequestError('interrupt', 'Claude did not answer the interrupt.')
  }
  const connection = claude.connections[0]!
  await openTurn(connection)

  const asked = Date.now()
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()
  // A turn Claude would not interrupt ends only with its child, so there is no grace to wait.
  expect(Date.now() - asked).toBeLessThan(CLAUDE_STOP_GRACE_MS / 2)

  expect(connection.closed).toBe(true)
  expect(await turnOutcome()).toBe('cancellation')
  const texts = await statusTexts()
  expect(texts).toContain('Cancellation requested.')
  expect(texts.some((text) => text.includes("didn't stop"))).toBe(false)
})

it('ends the child when the interrupt fails, with no unconfirmed row', async () => {
  claude.routes.interrupt = () => {
    throw new Error('control request lost')
  }
  const connection = claude.connections[0]!
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(await turnOutcome()).toBe('cancellation')
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
})

it('ends the child within the grace when Claude never answers the interrupt', async () => {
  // As the real control surface runs it: no answer ever comes, only the deadline Orca sets.
  claude.routes.interrupt = (options) =>
    runClaudeControl(
      'interrupt',
      () => new Promise(() => {}),
      typeof options?.timeoutMs === 'number' ? options.timeoutMs : undefined
    )
  const connection = claude.connections[0]!
  await openTurn(connection)

  const asked = Date.now()
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(Date.now() - asked).toBeLessThan(CLAUDE_STOP_GRACE_MS + 1_500)
  expect(await turnOutcome()).toBe('cancellation')
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
}, 15_000)

it('ends background work Claude runs when the Stop ends the child', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-start',
    task_id: 'background-1',
    task_type: 'local_agent',
    is_backgrounded: true
  })
  expect(backgroundStates.at(-1)).toMatchObject({ state: 'monitoring' })

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(backgroundStates.at(-1)).toBeNull()
})

it('starts a new child for the next send after a Stop, on the same Claude conversation', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  await stop()
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  const next = await send('Carry on.')
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)
    expect(started).not.toBe(connection)
    expect(started && wrote(started, 'Carry on.')).toBe(true)
    return started!
  })
  // The wake resumes the same Claude conversation; the first test pins the leaf it resumes after.
  expect(store.getRecord(SESSION)?.providerHandleChain.at(-1)?.handle).toMatchObject({
    sessionId: PROVIDER_SESSION_ID
  })
  expect(resumed.closed).toBe(false)
  expect(await dispatch(next)).toMatchObject({ state: 'pending' })
})

it('delivers a send issued with the pre-Stop fence during the Stop to the resumed child only', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  let childrenWhenClosed: number | undefined
  const close = connection.close
  connection.close = async () => {
    const proven = await close()
    childrenWhenClosed = claude.connections.length
    return proven
  }

  let answer!: () => void
  claude.routes.interrupt = () =>
    new Promise((resolve) => {
      answer = () => resolve({ still_queued: [], cancelled: [] })
    })

  // Issued while the Stop's first step waits on the interrupt: the client still holds the fence
  // the rest moves.
  const stopped = stop()
  await interruptSent(connection)
  const sent = send('Typed during the Stop.', fence)
  answer()
  expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)

  await expect(sent).resolves.toEqual(expect.any(String))
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Typed during the Stop.')).toBe(true)
    return started
  })
  // Handed over only after the old child's close resolved, and never to that child.
  expect(childrenWhenClosed).toBe(1)
  expect(resumed.closed).toBe(false)
  expect(wrote(connection, 'Typed during the Stop.')).toBe(false)
  expect(store.getRecord(SESSION)!.lease.runtimeFence).not.toBe(fence)
  expect((await statusTexts()).filter((text) => text !== 'Cancellation requested.')).toEqual([])
})

it("runs nothing queued during the Stop's first step before the child's end", async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  let answer!: () => void
  claude.routes.interrupt = () =>
    new Promise((resolve) => {
      answer = () => resolve({ still_queued: [], cancelled: [] })
    })

  const stopped = stop()
  await interruptSent(connection)
  // Any later operation on the chat, such as a prompt answer or an option change, queues here.
  let childLiveForNextOperation: boolean | undefined
  const next = host['tasks'].serialize(SESSION, async () => {
    childLiveForNextOperation = !connection.closed
  })
  answer()
  await stopped
  frame(connection, INTERRUPTED_RESULT)
  await next

  expect(childLiveForNextOperation).toBe(false)
})

it('still answers the Stop, with its row, when the child cannot be proven gone; the failure is reported', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const close = connection.close
  connection.close = async () => false

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  expect(sinkErrors).toEqual([
    expect.objectContaining({
      name: 'StructuredAgentSessionEvictionError',
      step: 'stop-provider-child'
    })
  ])
  connection.close = close
})

it('ends the child for a Stop naming the turn that just ended when Claude interrupts the follow-up', async () => {
  const connection = claude.connections[0]!
  const ended = await openTurn(connection)
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
  await eventually(async () =>
    expect(
      activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
    ).toBeNull()
  )
  // Handed over but not yet echoed: no turn of its own for a client to name.
  await send('Follow-up.')
  await eventually(() => expect(wrote(connection, 'Follow-up.')).toBe(true))

  // As the phone sends it: the turn it last saw working.
  await expect(stop(ended)).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  expect(connection.closed).toBe(true)
})

it('keeps a second Stop pressed while the first ends the child quiet', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  const second = stop()
  frame(connection, INTERRUPTED_RESULT)

  await expect(second).resolves.toMatchObject({ ok: true, value: { cancelled: false } })
  expect(connection.closed).toBe(true)
  expect(connection.calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(1)
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  expect(sinkErrors).toEqual([])
})
