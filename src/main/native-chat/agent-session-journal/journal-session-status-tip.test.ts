// A stored status names the history tip it was derived from. An older build writes history with no
// status, or deletes a chat, and the table carries no schema version to stop it: a row whose tip is
// not the chat's tip now reads as missing, is derived again, and is never selected to settle.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createTrackedJournalOpener,
  deleteTestJournalRow,
  insertTestJournalRowJson,
  liveTestJournalRows,
  loadTestJournal,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import {
  deriveJournalSessionStatus,
  hasJournalSessionStatus,
  readUnsettledJournalSessionIds
} from './journal-session-state'
import { CORPUS_FENCE, JOURNAL_SESSION_STATE_CORPUS } from './journal-session-state-test-corpus'
import { codexItem, item, runningTool } from './journal-session-state-test-writes'
import type { AgentSessionJournal } from './journal-store'

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-status-tip-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function open(sessionId: string): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId,
      workspaceId: 'ws-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
    },
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${sessionId}-${clock}`,
    currentFence: () => CORPUS_FENCE
  })
}

const db = () => openTestJournalHostDatabase(root).db
const stored = (sessionId: string) => readTestJournalSessionStatus(root, sessionId)

function freshDerivation(sessionId: string) {
  return deriveJournalSessionStatus(loadTestJournal(root, sessionId)!.state, {
    currentFence: CORPUS_FENCE
  })
}

/** The stored row as SQLite holds it, every column. */
function rawRow(sessionId: string): Record<string, unknown> {
  const row: unknown = db()
    .prepare('SELECT * FROM journal_session_state WHERE session_id = ?')
    .get(sessionId)
  if (typeof row !== 'object' || row === null) {
    throw new Error(`no status row for ${sessionId}`)
  }
  return Object.fromEntries(Object.entries(row))
}

/** Puts a row back exactly as it was: what is left when a build that keeps no status writes on. */
function putBack(row: Record<string, unknown>): void {
  const columns = Object.keys(row)
  db()
    .prepare(
      `INSERT OR REPLACE INTO journal_session_state (${columns.join(', ')})
VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...Object.values(row))
}

it('reads a row an older build wrote history past as missing, and derives it again', async () => {
  const journal = await open('chat')
  await JOURNAL_SESSION_STATE_CORPUS.settled(journal)
  const before = rawRow('chat')
  // The history an older build appends: a tool starts running, and the row stays as it was.
  await item(journal, codexItem('turn-1', 4), runningTool)
  await journal.close()
  putBack(before)

  expect(stored('chat')).toBeNull()
  expect(hasJournalSessionStatus(db(), 'chat')).toBe(false)
  expect(readUnsettledJournalSessionIds(db())).toEqual([])

  const reopened = await open('chat')
  reopened.sessionStatus.backfill()

  expect(stored('chat')).toEqual(freshDerivation('chat'))
  expect(stored('chat')).toMatchObject({ lifecycle: 'running' })
  expect(readUnsettledJournalSessionIds(db())).toEqual(['chat'])
})

it('reads a row as missing when a repair in the same epoch regrew the history to its tip', async () => {
  const journal = await open('chat')
  await JOURNAL_SESSION_STATE_CORPUS['running tool'](journal)
  await journal.close()
  const tip = liveTestJournalRows(db(), 'chat').at(-1)!
  expect(stored('chat')).not.toBeNull()

  // An older build's repair dropped the tip and wrote a row at the same sequence, later.
  deleteTestJournalRow(db(), 'chat', tip.seq)
  insertTestJournalRowJson(db(), 'chat', tip.seq, tip.rowJson, tip.ts + 1)

  expect(stored('chat')).toBeNull()
  expect(readUnsettledJournalSessionIds(db())).toEqual([])
})

it('never selects the row of a chat whose history is gone', async () => {
  const journal = await open('chat')
  await JOURNAL_SESSION_STATE_CORPUS['running tool'](journal)
  await journal.close()
  expect(readUnsettledJournalSessionIds(db())).toEqual(['chat'])

  // An older build deleted the chat and knew nothing of its status row.
  db().prepare('DELETE FROM journal_rows WHERE session_id = ?').run('chat')
  db().prepare('DELETE FROM journal_sessions WHERE session_id = ?').run('chat')

  expect(rawRow('chat')).toMatchObject({ lifecycle: 'running' })
  expect(readUnsettledJournalSessionIds(db())).toEqual([])
})
