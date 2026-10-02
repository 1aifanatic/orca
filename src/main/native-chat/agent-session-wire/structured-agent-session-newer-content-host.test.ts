// On a real host: what a newer Orca left in a chat, and a provider row the reader would reject,
// never leave the chat unable to take its next message.

import { cp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const relaunchedRoots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    relaunchedRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

function providerEvents() {
  const events = hostTestState().acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('no acquired provider')
  }
  return events
}

function emit(ordinal: number, body: AgentJournalItemBody): void {
  providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal },
    body,
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

function send(host: StructuredAgentSessionHost, text: string) {
  const body = hostTestMessage(text)
  return host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
}

async function historyBodies(host: StructuredAgentSessionHost): Promise<AgentJournalItemBody[]> {
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return page.page.items.map((item) => item.body)
}

/** A restarted process over the same files, holding no chat open and owning no provider. */
async function relaunch(): Promise<StructuredAgentSessionHost> {
  const before = hostTestState()
  await before.host.flushAllStreamedEvents()
  await before.store.renewLeases([])
  const relaunched = `${before.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process holds no lock.
  await cp(before.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  const store = await openTestAgentSessionRecordStore(relaunched)
  const host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(relaunched),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    now: () => NOW
  })
  replaceHostTestState({ store, host })
  return host
}

it("settles a newer Orca's pending approval as it was, and the chat takes its next message", async () => {
  await attach()
  // A subject kind this build does not know, still pending when its provider went away.
  const newerApproval: AgentJournalItemBody = JSON.parse(
    JSON.stringify({
      kind: 'approval',
      title: 'Review proposed change',
      detail: null,
      subject: { kind: 'diff', path: 'a.ts', text: 'not a plan' },
      options: [{ id: 'allow', label: 'Approve' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
  )
  emit(7, newerApproval)
  const host = await relaunch()

  expect(await send(host, 'after the newer approval')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(hostTestState().dispatch).toHaveBeenCalled())

  const approval = (await historyBodies(host)).find((body) => body.kind === 'approval')
  expect(approval).toMatchObject({
    subject: { kind: 'diff', path: 'a.ts', text: 'not a plan' },
    resolution: { state: 'cancelled' }
  })
  await host.flushAllStreamedEvents()
})

it('ends a turn whose provider output would not read back as failed, and the next send works', async () => {
  const closeSession = vi.fn(async () => true)
  Object.assign(hostTestState().host.deps.adapter, { closeSession })
  // A provider that names its generation, as the real adapters do, so its stop settles the turn.
  const { acquire } = hostTestState()
  const acquired = acquire.getMockImplementation()!
  acquire.mockImplementation(async (input) => ({
    ...(await acquired(input)),
    acquisitionGeneration: `generation-${acquire.mock.calls.length}`
  }))
  await attach()
  emit(1, {
    kind: 'status',
    text: 'Turn started',
    turnLifecycle: { turnId: 'turn-1', state: 'running', startedAt: NOW }
  })
  emit(2, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'written first' }] })
  // TypeScript accepts it; the persisted reader rejects a call id that is only spaces.
  emit(3, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: null, callId: '  ' }]
  })
  const { host, store } = hostTestState()
  await vi.waitFor(() => {
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'released' })
  })

  // The turn is over, with the notice any failed journal write gives.
  expect(await historyBodies(host)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'turn', turnId: 'turn-1', state: 'interrupted' }),
      expect.objectContaining({ kind: 'status', failure: { kind: 'hostFault' } })
    ])
  )
  expect(await send(host, 'the next message')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(hostTestState().acquire).toHaveBeenCalledTimes(2))

  const reopened = await relaunch()
  expect(await historyBodies(reopened)).toContainEqual(
    expect.objectContaining({ blocks: [{ type: 'text', text: 'written first' }] })
  )
  await reopened.flushAllStreamedEvents()
})
