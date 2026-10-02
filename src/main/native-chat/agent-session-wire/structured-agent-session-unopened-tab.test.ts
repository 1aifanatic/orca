// A restored chat whose open fails keeps its tab, so a phone on a headless host still lists it and
// its read says why, instead of the chat disappearing.

import { cp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
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

/** A restarted process over the chat's files, whose epoch row no longer parses. */
async function relaunchWithDamage(): Promise<StructuredAgentSessionHost> {
  const before = hostTestState()
  await attach()
  await before.host.flushStreamedEvents(SESSION)
  await before.store.renewLeases([])
  const relaunched = `${before.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process holds no lock.
  await cp(before.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  updateTestJournalRowJson(openTestJournalHostDatabase(relaunched).db, SESSION, 1, '}{')
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

it('lists a restored chat that could not be opened, and its send is refused as unloadable', async () => {
  const host = await relaunchWithDamage()
  const workspaceId = hostTestState().store.getRecord(SESSION)?.location.workspaceId

  await host.restoreReadableSessions([SESSION])

  expect(host.hasSession(SESSION)).toBe(false)
  expect(host.listSessionTabs()).toEqual([
    { sessionId: SESSION, workspaceId, agent: expect.any(String) }
  ])
  const body = hostTestMessage('sent to a damaged chat')
  await expect(
    host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).resolves.toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
  })

  await host.setSessionTabVisibility(SESSION, false)
  expect(host.listSessionTabs()).toEqual([])
  await host.flushAllStreamedEvents()
})
