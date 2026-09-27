// A send can be what opens a conversation this process has not read yet: a chat nobody has on
// screen after the app died, sent to from a phone or the CLI. Whatever that journal shows running
// belongs to a generation that is gone, so it is settled when the journal opens, not only when a
// new child starts: a start that then fails would leave the turn running for every reader.

import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
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

/** Delivery runs on its own serialized steps; under a loaded runner they take more than a second. */
function eventually(assertion: () => unknown): Promise<unknown> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

const relaunchedRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    relaunchedRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

/** A host that dies mid-turn, relaunched over a copy of its files taken at the crash. */
async function relaunchAfterCrashMidTurn() {
  const dying = hostTestState()
  await attach()
  const events = dying.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'crashed-turn', ordinal: 1 },
    { kind: 'turn', turnId: 'crashed-turn', state: 'running' }
  )
  await dying.host.flushStreamedEvents(SESSION)
  // An empty renewal queues behind every record write, so they are on disk.
  await dying.store.renewLeases([])
  const relaunched = `${dying.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process holds no lock.
  await cp(dying.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  const store = await AgentSessionRecordStore.open({
    directory: join(relaunched, 'store'),
    hostId: 'local'
  })
  const acquire = vi.fn(async () => {
    throw new Error('claude: command not found')
  })
  const host = new StructuredAgentSessionHost({
    store,
    adapter: { ...adapter(), acquire },
    journalRoot: relaunched,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    now: () => NOW
  })
  await host.reconcileRestartLeases()
  replaceHostTestState({ store, host })
  return { host, acquire }
}

function runningTurns(host: StructuredAgentSessionHost) {
  return host
    .journalSnapshot(SESSION)
    .items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
    .filter((turn) => turn.state === 'running')
}

it('settles a turn a dead generation left running when a send opens the chat and its start fails', async () => {
  const { host, acquire } = await relaunchAfterCrashMidTurn()
  expect(host.hasSession(SESSION)).toBe(false)

  const body = hostTestMessage('sent to a chat nobody has open')
  const sendEnvelope = envelope('agentSession.send', { body })
  await expect(host.send(CALLER, { envelope: sendEnvelope, body })).resolves.toMatchObject({
    ok: true
  })
  await eventually(() =>
    expect(
      host
        .journalSnapshot(SESSION)
        .submissions.find((entry) => entry.clientMessageId === sendEnvelope.clientOperationId)
    ).toMatchObject({ dispatchState: 'rejected' })
  )

  expect(acquire).toHaveBeenCalledOnce()
  expect(runningTurns(host)).toEqual([])
  await host.flushAllStreamedEvents()
})

it('settles the same turn when a reader opens the chat', async () => {
  const { host } = await relaunchAfterCrashMidTurn()

  await host.revealSession(SESSION)

  expect(runningTurns(host)).toEqual([])
  await host.flushAllStreamedEvents()
})
