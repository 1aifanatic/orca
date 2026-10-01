// A Claude Stop whose close could not prove the child gone, then the user's next message, on the
// shipping adapter and host. That child takes no input, so the send retries the stop first; still
// unproven, the message waits with its reason until a later retry proves the exit.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { claudeUnwrittenUserMessageError } from '../../claude/claude-agent-sdk-user-message-queue'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
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
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let sinkErrors: unknown[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-unproven-stop-send-'))
  resetHostTestOperationIds()
  sinkErrors = []
  claude = fakeClaude({
    replayUuid: null,
    routes: { interrupt: () => ({ still_queued: [], cancelled: [] }) }
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
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
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

function envelope(method: 'agentSession.send' | 'agentSession.cancel', fields: object) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields: { ...fields }
    })
  }
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error(`send refused: ${JSON.stringify(sent.refusal)}`)
  }
  return sent.value.clientMessageId
}

async function submission(clientMessageId: string) {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function wrote(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}

async function openTurn(connection: FakeConnection): Promise<void> {
  const text = 'Write a long reply.'
  const clientMessageId = await send(text)
  await eventually(() => expect(wrote(connection, text)).toBe(true))
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
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
  await eventually(async () =>
    expect((await submission(clientMessageId))?.dispatchState).toBe('accepted')
  )
  expect(
    activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
  ).not.toBeNull()
}

function stop() {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
}

function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

/** As the real connection: once a close begins it refuses every write, proven or not. */
function closeUnprovenFor(connection: FakeConnection, failures: number): void {
  const close = connection.close
  let left = failures
  connection.close = async () => {
    if (left === 0) {
      return close()
    }
    left -= 1
    connection.closeCount += 1
    connection.closed = true
    return false
  }
  const write = connection.send
  connection.send = (message, beforeDispatch) =>
    connection.closed
      ? Promise.reject(
          claudeUnwrittenUserMessageError(new Error('claude stream-json connection is closed'))
        )
      : write(message, beforeDispatch)
}

const INTERRUPTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  uuid: 'interrupted-result'
}

/** Stops a turn whose child's close cannot prove the exit `failures` times, and lets the Stop's
 *  second step fail on it. */
async function stopWithUnprovenClose(failures: number): Promise<FakeConnection> {
  const connection = claude.connections[0]!
  await openTurn(connection)
  closeUnprovenFor(connection, failures)
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(connection.closeCount).toBe(1)
  expect(owedWindDown()).toBeDefined()
  return connection
}

function owedWindDown() {
  return host['sessions'].get(SESSION)?.owesProviderChildWindDown
}

async function waitRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.failure?.kind === 'previousExitUnverifiable'
      ? [item.body]
      : []
  )
}

async function resumedWith(connection: FakeConnection, text: string): Promise<FakeConnection> {
  return eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, text)).toBe(true)
    return started
  })
}

it('retries the close a Stop could not prove before the next message, then sends it to a resumed child', async () => {
  const connection = await stopWithUnprovenClose(1)

  const next = await send('Carry on.')
  const resumed = await resumedWith(connection, 'Carry on.')

  expect(connection.closeCount).toBe(2)
  expect(wrote(connection, 'Carry on.')).toBe(false)
  expect(resumed.closed).toBe(false)
  expect(owedWindDown()).toBeUndefined()
  expect((await submission(next))?.dispatchState).toBe('pending')
  expect(await waitRows()).toEqual([])
})

it('holds the message with its reason while the exit stays unverifiable, and sends it once a later retry proves it', async () => {
  const connection = await stopWithUnprovenClose(3)

  // Never refused: the send is accepted and returns at once.
  const next = await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()
  expect(await waitRows()).toEqual([
    {
      kind: 'status',
      tone: 'warning',
      text: "Orca couldn't confirm Claude's previous process ended. Your message will send once it has.",
      failure: { kind: 'previousExitUnverifiable' }
    }
  ])
  // Still queued, drawn below the chat; never written to the child the Stop could not end.
  expect(await submission(next)).toMatchObject({ dispatchState: 'pending' })
  expect((await submission(next))?.handedOverAt).toBeUndefined()
  expect(claude.connections).toHaveLength(1)
  expect(wrote(connection, 'Carry on.')).toBe(false)
  expect(owedWindDown()).toBeDefined()
  // The Stop's attempt and the send's one retry: the row's own commit retries nothing.
  expect(connection.closeCount).toBe(2)

  // A second message retries once more, and waits under the same row.
  const second = await send('And this.')
  await eventually(() => expect(connection.closeCount).toBe(3))
  await laneDrained()
  expect(await submission(second)).toMatchObject({ dispatchState: 'pending' })
  expect(await waitRows()).toHaveLength(1)

  // The sweep's next tick retries the stop; the exit is proven and both messages go out.
  await host['lifetime'].idleSweep.tick()
  const resumed = await resumedWith(connection, 'Carry on.')
  await eventually(() => expect(wrote(resumed, 'And this.')).toBe(true))
  expect(connection.closeCount).toBe(4)
  expect(owedWindDown()).toBeUndefined()
  expect(await waitRows()).toHaveLength(1)
})

it('lets a held message be withdrawn with Stop, and the owed stop still ends on the next retry', async () => {
  const connection = await stopWithUnprovenClose(2)
  const next = await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await submission(next)).toMatchObject({ dispatchState: 'rejected' })
  expect(owedWindDown()).toBeDefined()

  await host['lifetime'].idleSweep.tick()
  expect(connection.closeCount).toBe(3)
  expect(owedWindDown()).toBeUndefined()
  expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  // Nothing was waiting, so no child starts.
  expect(claude.connections).toHaveLength(1)
  expect(wrote(connection, 'Carry on.')).toBe(false)
})
