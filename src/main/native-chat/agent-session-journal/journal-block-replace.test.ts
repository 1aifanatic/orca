// T-block: rewinding one chat among interleaved peers rewrites that chat's rows, not the file's.
//
// Written only against the store, so the same case measures any key layout: under block keys a
// chat's rows are one contiguous range, and a replace frees that range; under a key whose table
// order follows insertion, the chat's rows are spread across every leaf its peers share.

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { journalDatabasePath } from './journal-host-database'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

const PEERS = 19
const ROWS_PER_CHAT = 600
const TEXT = 'x'.repeat(500)

let root: string
const journals = createTrackedJournalOpener()

function identity(index: number): AgentSessionJournalIdentity {
  return {
    sessionId: `session-${index}`,
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: `thread-${index}` }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-block-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('replaces one chat among 19 interleaved peers with a write-ahead log a fraction of its size', async () => {
  // Seeding only: the case measures the replace, not ten thousand fsyncs before it.
  openTestJournalHostDatabase(root).db.pragma('synchronous = OFF')
  const chats: AgentSessionJournal[] = []
  for (let index = 0; index <= PEERS; index += 1) {
    chats.push(await journals.open({ identity: identity(index), stateDirectory: root }))
  }
  // Interleaved, as concurrent chats write: every chat's row n lands before any chat's row n + 1.
  for (let ordinal = 1; ordinal <= ROWS_PER_CHAT; ordinal += 1) {
    for (const [index, chat] of chats.entries()) {
      await chat.appendItem(
        { provider: 'codex', threadId: `thread-${index}`, turnId: 'turn-1', ordinal },
        { kind: 'status', text: TEXT },
        { fence: 1 }
      )
    }
  }
  const database = openTestJournalHostDatabase(root)
  // A free-page pass writes its own WAL frames a turn after a delete; this measures the replace alone.
  // The seed never yields a turn, so the pass opening the chats started is still waiting: drain it first.
  await database.reclaimFreePages()
  vi.spyOn(database, 'reclaimFreePages').mockResolvedValue()
  const { db } = database
  db.pragma('synchronous = FULL')
  db.pragma('wal_autocheckpoint = 0')
  db.pragma('wal_checkpoint(TRUNCATE)')
  const walPath = `${journalDatabasePath(root)}-wal`
  const total = db.prepare('SELECT sum(length(row_json)) AS total FROM journal_rows').get()?.total
  const chatBytes = Number(total) / (PEERS + 1)

  await chats[0]!.replaceEpochItems('legacy_import', 1, [
    {
      identity: { provider: 'codex', threadId: 'thread-0', turnId: 'turn-9', ordinal: 1 },
      body: { kind: 'status', text: 'rewound' }
    }
  ])

  // Measured on this seed: block keys about 0.7x the chat's bytes; a key whose table order follows
  // insertion about 6x, the whole file. The G2 rewind row measures the largest real chat.
  const walBytes = (await stat(walPath)).size
  expect(walBytes).toBeLessThan(chatBytes)
}, 120_000)
