// A stored status names the history tip it was derived from and the rules it was derived by. An
// older build writes history with no status, or deletes a chat, and the table carries no schema
// version to stop it: a row whose tip is not the chat's tip now, or whose rules are other, reads as
// missing, is derived again, and is never selected to settle.

import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
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
  publishTestJournalEpoch,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import {
  deriveJournalSessionStatus,
  hasJournalSessionStatus,
  JOURNAL_SESSION_STATUS_RULES,
  readUnsettledJournalSessionIds
} from './journal-session-state'
import { CORPUS_FENCE, JOURNAL_SESSION_STATE_CORPUS } from './journal-session-state-test-corpus'
import { codexItem, item, runningTool } from './journal-session-state-test-writes'
import type { AgentSessionJournal } from './journal-store'
import type { SqliteRow } from '../../sqlite/sqlite-statement'

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
      providerHandle: codexProviderHandle(`thread-${sessionId}`)
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
function rawRow(sessionId: string): SqliteRow {
  const row = db()
    .prepare('SELECT * FROM journal_session_state WHERE session_id = ?')
    .get(sessionId)
  if (!row) {
    throw new Error(`no status row for ${sessionId}`)
  }
  return row
}

/** Puts a row back exactly as it was: what is left when a build that keeps no status writes on. */
function putBack(row: SqliteRow): void {
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

it('reads a row as missing when an older build moved the chat to a new epoch, even at the same tip', async () => {
  const journal = await open('chat')
  await JOURNAL_SESSION_STATE_CORPUS['running tool'](journal)
  await journal.close()
  const tip = liveTestJournalRows(db(), 'chat').at(-1)!

  // A new epoch whose newest row matches the old tip's sequence and time.
  publishTestJournalEpoch(db(), 'chat', 'epoch-older-build')
  insertTestJournalRowJson(db(), 'chat', tip.seq, tip.rowJson, tip.ts)

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

it('reads a row derived by other rules as missing, never selects it, and derives it again', async () => {
  const journal = await open('chat')
  await JOURNAL_SESSION_STATE_CORPUS['running tool'](journal)
  await journal.close()
  db()
    .prepare('UPDATE journal_session_state SET rules_version = ? WHERE session_id = ?')
    .run(JOURNAL_SESSION_STATUS_RULES - 1, 'chat')

  expect(stored('chat')).toBeNull()
  expect(hasJournalSessionStatus(db(), 'chat')).toBe(false)
  expect(readUnsettledJournalSessionIds(db())).toEqual([])

  const reopened = await open('chat')
  reopened.sessionStatus.backfill()

  expect(rawRow('chat')).toMatchObject({ rules_version: JOURNAL_SESSION_STATUS_RULES })
  expect(stored('chat')).toEqual(freshDerivation('chat'))
  expect(readUnsettledJournalSessionIds(db())).toEqual(['chat'])
})
