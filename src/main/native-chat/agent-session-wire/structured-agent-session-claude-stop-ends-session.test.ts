// A Stop ends Claude's child on the shipping adapter: after the interrupt, once the stopped turn
// ends or its grace runs out, whatever Claude answered. The chat rests; the next send resumes it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { ClaudeControlRequestError } from '../../claude/claude-agent-sdk-control-requests'
import { CLAUDE_STOP_GRACE_MS } from '../../claude/claude-stop-grace'
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-stop-ends-session-'))
  resetHostTestOperationIds()
  queued = []
  events = []
  backgroundStates = []
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
  fields: Record<string, unknown>
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
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

function stop() {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
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

it('ends the child once the stopped turn ends, and the chat rests at that turn', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)

  const stopped = stop()
  await interruptSent(connection)
  // The interrupt was taken: the child stays until Claude ends the turn itself.
  expect(connection.closed).toBe(false)
  const ended = Date.now()
  frame(connection, INTERRUPTED_RESULT)
  await expect(stopped).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  // The turn's own end releases the grace; it is not waited out.
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

  const stopped = stop()
  await interruptSent(connection)
  frame(connection, INTERRUPTED_RESULT)
  await expect(stopped).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  expect(connection.closed).toBe(true)
  // Withdrawn by Claude's own receipt, so it is never re-sent and never read as delivered.
  expect(await dispatch(followUp)).toEqual({
    state: 'rejected',
    reason: DISPATCH_REJECTED_CANCELLED
  })
})

it('ends the child when Claude refuses the interrupt, and says only that the stop was asked', async () => {
  claude.routes.interrupt = () => {
    throw new ClaudeControlRequestError('interrupt', 'Claude did not answer the interrupt.')
  }
  const connection = claude.connections[0]!
  await openTurn(connection)

  const asked = Date.now()
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  // A turn Claude would not interrupt ends only with its child, so there is no grace to wait.
  expect(Date.now() - asked).toBeLessThan(CLAUDE_STOP_GRACE_MS / 2)

  expect(connection.closed).toBe(true)
  expect(await turnOutcome()).toBe('cancellation')
  const texts = await statusTexts()
  expect(texts).toContain('Cancellation requested.')
  expect(texts.some((text) => text.includes("didn't stop"))).toBe(false)
})

it('ends the child when the interrupt goes unanswered, with no unconfirmed row', async () => {
  claude.routes.interrupt = () => {
    throw new Error('control request timed out')
  }
  const connection = claude.connections[0]!
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  expect(connection.closed).toBe(true)
  expect(await turnOutcome()).toBe('cancellation')
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
})

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

  const stopped = stop()
  await interruptSent(connection)
  frame(connection, INTERRUPTED_RESULT)
  await expect(stopped).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  expect(connection.closed).toBe(true)
  expect(backgroundStates.at(-1)).toBeNull()
})

it('starts a new child for the next send after a Stop, on the same Claude conversation', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const stopped = stop()
  await interruptSent(connection)
  frame(connection, INTERRUPTED_RESULT)
  await stopped

  const next = await send('Carry on.')
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)
    expect(started).not.toBe(connection)
    expect(started?.sent.some((message) => JSON.stringify(message).includes('Carry on.'))).toBe(
      true
    )
    return started!
  })
  // The wake resumes the same Claude conversation; the first test pins the leaf it resumes after.
  expect(store.getRecord(SESSION)?.providerHandleChain.at(-1)?.handle).toMatchObject({
    sessionId: PROVIDER_SESSION_ID
  })
  expect(resumed.closed).toBe(false)
  expect(await dispatch(next)).toMatchObject({ state: 'pending' })
})
