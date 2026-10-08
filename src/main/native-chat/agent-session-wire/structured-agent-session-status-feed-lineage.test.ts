import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { commitConversationClearRecord } from '../../runtime/agent-session-conversation-command-record'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'

const journals = createTrackedJournalOpener()
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-sender-lineage-'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(directory, { recursive: true, force: true })
})

async function rig() {
  const journal = await journals.open({
    identity: {
      sessionId: 'root-chat',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('provider')
    },
    stateDirectory: directory,
    now: () => 100
  })
  const root = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'root-chat' }))
  const records = new Map<string, AgentSessionRecord>([['root-chat', root]])
  const state: AgentSessionStoreState = {
    records,
    unreadableRecords: new Map(),
    operations: new Map(),
    retiredClaimKeys: [],
    sessionTabs: null
  }
  const sessions = new Map([['root-chat', indexedStatusFeedSession({ journal })]])
  const getRecord = vi.fn((id: string) => records.get(id) ?? null)
  const listRecords = vi.fn(() => [...records.values()])
  const makeFeed = (withLineage = true) =>
    new StructuredAgentSessionStatusFeed({
      sessions,
      getRecord,
      ...(withLineage ? { listRecords } : {}),
      now: () => 100,
      logger: createStructuredAgentSessionLogger()
    })
  const feed = makeFeed()
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'current', emit: (event) => events.push(event) })
  const commit = (from: string, to: string) => {
    const previous = records.get(from)!
    commitConversationClearRecord(state, {
      sessionId: from,
      fence: previous.lease.runtimeFence,
      command: {
        command: 'clear',
        phase: 'committed',
        state: 'completed',
        operationId: `op-${to}`,
        callerKey: 'caller',
        replacementSessionId: to
      },
      claimKeyId: 'key',
      now: 100
    })
  }
  const clear = (from: string, to: string) => {
    commit(from, to)
    feed.publishConversationCommand(from)
    sessions.set(to, indexedStatusFeedSession({ journal }))
    feed.publish(to)
  }
  return { journal, records, sessions, feed, events, commit, clear, makeFeed, getRecord, listRecords }
}

it('publishes the committed current owner through successive clears and reload, preserving historical rows', async () => {
  const { records, sessions, feed, clear, makeFeed } = await rig()
  expect(feed.readPublished('root-chat')?.orchestrationSessionId).toBe('root-chat')
  clear('root-chat', 'clear-one')
  expect(feed.readPublished('root-chat')?.orchestrationSessionId).toBeNull()
  expect(feed.readPublished('clear-one')?.orchestrationSessionId).toBe('root-chat')
  clear('clear-one', 'clear-two')
  expect(feed.readPublished('clear-one')?.orchestrationSessionId).toBeNull()
  expect(feed.readPublished('clear-two')?.orchestrationSessionId).toBe('root-chat')
  const current = records.get('clear-two')!
  records.set('clear-two', { ...current, conversationName: 'Renamed successor' })
  feed.publishConversationName('clear-two')
  expect(feed.readPublished('clear-two')).toMatchObject({
    orchestrationSessionId: 'root-chat',
    conversationName: 'Renamed successor'
  })
  sessions.delete('root-chat')
  sessions.delete('clear-one')
  const snapshot: AgentSessionStatusEvent[] = []
  makeFeed().subscribe({ id: 'reloaded', emit: (event) => snapshot.push(event) })
  expect(snapshot.at(-1)).toMatchObject({
    type: 'snapshot',
    sessions: [{ sessionId: 'clear-two', orchestrationSessionId: 'root-chat' }]
  })
})

it('indexes records once and walks a shared clear lineage once for a reload snapshot', async () => {
  const { records, feed, clear, getRecord, listRecords } = await rig()
  clear('root-chat', 'clear-one')
  clear('clear-one', 'clear-two')
  getRecord.mockClear()
  listRecords.mockClear()
  feed.subscribe({ id: 'bounded-reload', emit: () => {} })
  expect(listRecords).toHaveBeenCalledOnce()
  expect(getRecord.mock.calls.length).toBeLessThanOrEqual(records.size * 2)
  expect(feed.readPublished('clear-two')?.orchestrationSessionId).toBe('root-chat')
})

it('does not invent lineage support when the record reader predates it', async () => {
  const { sessions, makeFeed, listRecords } = await rig()
  const legacy = makeFeed(false)
  const events: AgentSessionStatusEvent[] = []
  legacy.subscribe({ id: 'legacy', emit: (event) => events.push(event) })
  expect(legacy.readPublished('root-chat')).not.toHaveProperty('orchestrationSessionId')
  legacy.revokeLive('root-chat')
  sessions.delete('root-chat')
  events.length = 0
  listRecords.mockClear()
  legacy.publishConversationCommand('root-chat')
  expect(legacy.readPublished('root-chat')).not.toHaveProperty('orchestrationSessionId')
  expect(listRecords).not.toHaveBeenCalled()
  expect(events).toEqual([])
})

it('does not repeat ownership events for an unchanged committed edge', async () => {
  const { sessions, feed, clear, events, listRecords } = await rig()
  clear('root-chat', 'clear-one')
  feed.close('root-chat')
  sessions.delete('root-chat')
  events.length = 0
  listRecords.mockClear()
  feed.publishConversationCommand('root-chat')
  expect(listRecords).toHaveBeenCalledOnce()
  expect(events).toEqual([])
  expect(feed.readPublished('root-chat')?.orchestrationSessionId).toBeNull()
  expect(feed.readPublished('clear-one')?.orchestrationSessionId).toBe('root-chat')
})

it('shares one index at a committed change and keeps ordinary publication scoped', async () => {
  const { journal, records, sessions, feed, clear, commit, events, getRecord, listRecords } = await rig()
  clear('root-chat', 'clear-one')
  clear('clear-one', 'clear-two')
  for (let index = 0; index < 8; index++) {
    const sessionId = `unrelated-${index}`
    records.set(sessionId, agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })))
    sessions.set(sessionId, indexedStatusFeedSession({ journal }))
    feed.publish(sessionId)
  }
  feed.close('root-chat')
  feed.close('clear-one')
  sessions.delete('root-chat')
  sessions.delete('clear-one')
  commit('clear-two', 'clear-three')
  const unrelated = records.get('unrelated-0')!
  records.set('unrelated-0', { ...unrelated, conversationName: 'Other conversation' })
  events.length = 0
  listRecords.mockClear()
  feed.publish('unrelated-0')
  expect(listRecords).not.toHaveBeenCalled()
  expect(events).toMatchObject([{ type: 'status', session: { sessionId: 'unrelated-0' } }])
  expect(feed.readPublished('clear-two')?.orchestrationSessionId).toBe('root-chat')
  events.length = 0
  getRecord.mockClear()
  listRecords.mockClear()
  feed.publishConversationCommand('clear-two')
  expect(listRecords).toHaveBeenCalledOnce()
  expect(getRecord.mock.calls.length).toBeLessThanOrEqual(records.size * 2)
  expect(events).toMatchObject([
    { type: 'status', session: { sessionId: 'clear-two', orchestrationSessionId: null } }
  ])
})

it.each(['missing', 'loop', 'other-host'])(
  'does not publish a current owner for %s committed lineage',
  async (kind) => {
    const { records, feed, clear } = await rig()
    clear('root-chat', 'clear-one')
    if (kind === 'missing') {
      records.delete('clear-one')
    } else if (kind === 'other-host') {
      const record = records.get('clear-one')!
      records.set('clear-one', {
        ...record,
        location: { ...record.location, executionHostId: 'ssh:elsewhere' }
      })
    } else {
      const record = records.get('clear-one')!
      records.set('clear-one', {
        ...record,
        conversationCommand: {
          command: 'clear',
          phase: 'committed',
          state: 'completed',
          operationId: 'bad',
          callerKey: 'caller',
          replacementSessionId: 'root-chat'
        }
      })
    }
    feed.subscribe({ id: 'after-corruption', emit: () => {} })
    expect(feed.readPublished('root-chat')?.orchestrationSessionId).toBeNull()
    expect(feed.readPublished('clear-one')?.orchestrationSessionId).toBeNull()
  }
)
