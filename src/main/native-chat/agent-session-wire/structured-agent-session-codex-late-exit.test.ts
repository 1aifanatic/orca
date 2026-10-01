// A Codex chat whose close could not prove the app-server gone, then the user's next message, on the
// shipping adapter and host. The message waits on that close; when the old app-server is later seen
// to exit, the close is retried at once and the message goes out, with no idle-sweep tick.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { fakeCodex } from '../../codex/codex-structured-session-adapter-fixture'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionEvent
} from '../../codex/codex-structured-session-adapter'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredCodexLifecycleEvent } from '../../runtime/structured-codex-lifecycle-event'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let store: AgentSessionRecordStore
let codex: ReturnType<typeof fakeCodex>
let events: CodexStructuredSessionEvent[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-late-exit-'))
  resetHostTestOperationIds()
  events = []
  codex = fakeCodex()
  let generation = 0
  const adapter = new CodexStructuredSessionAdapter({
    // As the shipping resolver: a restart resumes the thread the record names.
    resolveLaunch: async () => {
      const head = agentSessionProviderHandleChainHead(
        store.getRecord(SESSION)?.providerHandleChain ?? []
      )
      return {
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: null,
        resumeThreadId: head?.handle.provider === 'codex' ? head.handle.threadId : null
      }
    },
    // As the runtime routes them: what the host's lifecycle handler consumes reaches it.
    onEvent: (event) => {
      events.push(event)
      const lifecycleEvent = structuredCodexLifecycleEvent(event)
      if (lifecycleEvent) {
        void host.handleAdapterEvent(lifecycleEvent)
      }
    },
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW,
    mintAcquisitionGeneration: () => `generation-${++generation}`
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    logger: recordingStructuredAgentSessionLogger().logger,
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

async function send(text: string): Promise<void> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(`send refused: ${JSON.stringify(sent.refusal)}`)
  }
}

async function waitRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.filter(
    (item) => item.body.kind === 'status' && item.body.failure?.kind === 'previousExitUnverifiable'
  )
}

type CodexConnection = (typeof codex.connections)[number]

function startedTurnWith(connection: CodexConnection, text: string): boolean {
  return connection.calls.some(
    (call) => call.method === 'turn/start' && JSON.stringify(call.params).includes(text)
  )
}

/** Closes the chat with an app-server whose close cannot prove the exit, then holds a message. */
async function heldAfterUnprovenClose(): Promise<CodexConnection> {
  const connection = codex.connections[0]!
  const close = connection.close
  let unproven = 2
  connection.close = async () => {
    if (unproven === 0) {
      return close()
    }
    unproven -= 1
    connection.closeCount += 1
    return false
  }
  await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
  expect(host['sessions'].get(SESSION)?.owesProviderChildWindDown).toMatchObject({
    cause: 'user-close'
  })
  await send('Carry on.')
  await vi.waitFor(async () => expect(await waitRows()).toHaveLength(1))
  expect(connection.closeCount).toBe(2)
  expect(codex.connections).toHaveLength(1)
  return connection
}

function exitReports(): number {
  return events.filter((event) => event.type === 'exitAfterClose').length
}

it('sends a held message as soon as the old app-server exits after its close gave up', async () => {
  const connection = await heldAfterUnprovenClose()

  connection.handlers.onExitAfterClose?.()
  const resumed = await vi.waitFor(() => {
    const next = codex.connections.at(-1)!
    expect(next).not.toBe(connection)
    expect(startedTurnWith(next, 'Carry on.')).toBe(true)
    return next
  })

  expect(connection.closeCount).toBe(3)
  expect(startedTurnWith(connection, 'Carry on.')).toBe(false)
  expect(resumed.closeCount).toBe(0)
  expect(host['sessions'].get(SESSION)?.owesProviderChildWindDown).toBeUndefined()
})

it("drops a late exit report from an app-server that is no longer the chat's", async () => {
  const connection = await heldAfterUnprovenClose()
  connection.handlers.onExitAfterClose?.()
  const resumed = await vi.waitFor(() => {
    const next = codex.connections.at(-1)!
    expect(startedTurnWith(next, 'Carry on.')).toBe(true)
    return next
  })
  expect(exitReports()).toBe(1)

  connection.handlers.onExitAfterClose?.()

  expect(exitReports()).toBe(1)
  expect(resumed.closeCount).toBe(0)
})
