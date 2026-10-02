import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryRequest,
  AgentSessionSubscribeEvent
} from '../../src/shared/agent-session-wire'
import type { AgentJournalCursor } from '../../src/shared/agent-session-journal-types'
import Database from '../../src/main/sqlite/sync-database'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener
} from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { JOURNAL_DB_SCHEMA_VERSION } from '../../src/main/native-chat/agent-session-journal/journal-database-schema'
import type { AgentSessionJournal } from '../../src/main/native-chat/agent-session-journal/journal-store'
import { readAgentSessionHistory } from '../../src/main/native-chat/agent-session-wire/agent-session-history-page'
import { AgentSessionSubscribers } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-subscribers'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from '../../src/renderer/src/components/native-chat/structured-agent-session-read-owner'

const SESSION = 'read-only-reconnect'
const target = { kind: 'local' } as const
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  vi.resetAllMocks()
  root = await mkdtemp(join(tmpdir(), 'orca-read-only-reconnect-'))
})
afterEach(async () => {
  resetStructuredAgentSessionReadOwnersForTests()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'folder-workspace',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    stateDirectory: root
  })
}

/** Reopens the host's journal on a database stamped `version`, as a host restarting would. */
async function reopenAt(version: number): Promise<AgentSessionJournal> {
  await journals.closeAll()
  closeTestJournalHostDatabase(root)
  const db = new Database(join(root, 'agent-session-journal.db'))
  db.pragma(`user_version = ${version}`)
  db.close()
  return open()
}

/** Serves the client from whichever journal the host holds now. */
function serve(host: { journal: AgentSessionJournal }): void {
  mocks.call.mockImplementation((_target, _method, request: AgentSessionHistoryRequest) =>
    Promise.resolve(structuredClone(readAgentSessionHistory(host.journal, request)))
  )
  mocks.subscribe.mockImplementation(
    (
      _target,
      request: { cursor?: AgentJournalCursor },
      onEvent: (event: AgentSessionSubscribeEvent) => void
    ) =>
      Promise.resolve({
        unsubscribe: new AgentSessionSubscribers().open({
          id: 'pane',
          sessionId: SESSION,
          journal: host.journal,
          fence: 1,
          cursor: request.cursor,
          emit: (event) => onEvent(structuredClone(event))
        })
      })
  )
}

it('reconnects a read-only chat for a whole page, so an updated host unlocks it', async () => {
  const first = await open()
  await first.appendItem(
    { provider: 'orca', clientMessageId: 'hello' },
    { kind: 'status', text: 'hello' },
    { fence: 1 }
  )
  const host = { journal: await reopenAt(JOURNAL_DB_SCHEMA_VERSION + 1) }
  expect(host.journal.isReadOnly).toBe(true)
  serve(host)
  const owner = getStructuredAgentSessionReadOwner(SESSION, target)
  const unlisten = owner.subscribe(() => {})
  const deactivate = owner.activate()
  await vi.waitFor(() => expect(owner.getSnapshot().state.readOnly).toBe('written-by-newer-orca'))
  await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
  deactivate()

  host.journal = await reopenAt(JOURNAL_DB_SCHEMA_VERSION)
  expect(host.journal.isReadOnly).toBe(false)
  const stop = owner.activate()
  await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2))
  expect(mocks.subscribe.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION })
  await vi.waitFor(() => expect(owner.getSnapshot().state).not.toHaveProperty('readOnly'))
  stop()
  unlisten()
})
