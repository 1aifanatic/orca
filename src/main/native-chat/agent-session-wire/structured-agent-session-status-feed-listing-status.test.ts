// The status feed saves each chat's settled status for the next boot's listing. A save is
// bookkeeping and may fail; the next read of the same status retries it instead of stranding it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'

const SESSION = 'listing-status-session'

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-feed-listing-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function settled(): Promise<void> {
  // The save joins the chat's queue behind the rows it describes.
  await new Promise<void>((resolve) => setImmediate(resolve))
}

it('retries a failed listing status save on the next read of a cached projection', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    stateDirectory: join(root, SESSION)
  })
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 1 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
    { fence: 1 }
  )
  const { db } = openTestJournalHostDatabase(join(root, SESSION))
  const prepare = db.prepare.bind(db)
  let failures = 1
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    if (sql.startsWith('UPDATE journal_sessions SET status_json') && failures-- > 0) {
      throw new Error('disk I/O error')
    }
    return prepare(sql)
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const savedAt = () =>
    db.prepare('SELECT status_seq FROM journal_sessions WHERE session_id = ?').get(SESSION)
      ?.status_seq ?? null
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([[SESSION, indexedStatusFeedSession({ journal })]]),
    getRecord: () => null,
    now: () => 1_000
  })
  feed.subscribe({ id: 'list-1', emit: () => undefined })
  await settled()
  expect(warn).toHaveBeenCalledOnce()
  expect(savedAt()).toBeNull()
  const snapshot = vi.spyOn(journal, 'snapshot')

  feed.publish(SESSION)
  await settled()

  // Retried from the cached projection: the journal is not read again.
  expect(snapshot).not.toHaveBeenCalled()
  expect(savedAt()).toBe(journal.cursor().sequence)
})
