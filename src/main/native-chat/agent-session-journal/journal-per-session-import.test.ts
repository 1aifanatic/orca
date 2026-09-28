// A chat's per-chat journal file from an earlier build is copied into the host's one database on
// that chat's first open: verbatim, once, and retired only after the copy commits.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import Database from '../../sqlite/sync-database'
import { createStructuredAgentSessionRestartOfferWithdrawal } from '../agent-session-wire/structured-agent-session-restart-offer-withdrawal'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { journalDirectoryFor, legacyJournalDatabaseFile } from './journal-paths'
import { importPerSessionJournal } from './journal-per-session-import'
import { readJournalEpochRows, type JournalStoredRow } from './journal-row-table'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-legacy',
  workspaceId: 'ws-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function legacyDir(): string {
  return journalDirectoryFor(root, IDENTITY)
}

/** Real rows, written by today's store into a scratch database, as an earlier build wrote them. */
async function historyRows(): Promise<{ epoch: string; rows: JournalStoredRow[] }> {
  const scratch = join(root, 'scratch')
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: scratch,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-from-the-earlier-build'
  })
  await journal.appendSubmission({
    clientMessageId: 'client-1',
    payloadFingerprint: 'fp-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'add a retry' }] },
    fence: 1,
    handoverRecorded: true
  })
  await journal.appendItem(
    item(1),
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'On it.' }] },
    { fence: 1 }
  )
  const rows = readJournalEpochRows(
    openTestJournalHostDatabase(scratch).db,
    IDENTITY.sessionId,
    journal.epoch
  )
  return { epoch: journal.epoch, rows }
}

/** The per-chat file an earlier build left, in its own schema. */
async function writeLegacyJournal(epoch: string, rows: readonly JournalStoredRow[]): Promise<void> {
  const path = legacyJournalDatabaseFile(legacyDir())
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`
CREATE TABLE journal_rows (session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (session_id, epoch, seq));
CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE journal_repairs (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  content_from INTEGER NOT NULL, repaired_at INTEGER NOT NULL);`)
    db.pragma('user_version = 2')
    const insert = db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(IDENTITY.sessionId, row.epoch, row.seq, row.ts, row.rowJson)
    }
    if (rows.length > 0) {
      db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(IDENTITY.sessionId, epoch, 1)
    }
  } finally {
    db.close()
  }
}

function openChat() {
  return journals.open({ identity: IDENTITY, stateDirectory: root, now: () => (clock += 1) })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-per-session-import-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('importing a per-chat journal', () => {
  it('copies the history verbatim on first open and retires the file', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)

    const journal = await openChat()

    expect(journal.epoch).toBe(epoch)
    expect(journal.cursor()).toEqual({ epoch, sequence: rows.length })
    expect(
      readJournalEpochRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId, epoch)
    ).toEqual(rows)
    expect(existsSync(legacyDir())).toBe(false)
    expect(existsSync(`${legacyDir()}.imported`)).toBe(true)
  })

  // T-B3: the upgrade restart is the restart that produced the offers. A new epoch or renumbered
  // rows would silently withdraw every "resume after update" offer.
  it('keeps a restart offer taken before the upgrade', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `movedOn` reads only the session id and the journal cursor.
    const marker = {
      sessionId: IDENTITY.sessionId,
      journalCursor: { epoch, sequence: rows.length }
    } as AgentSessionResumeMarker

    const journal = await openChat()
    const withdrawal = createStructuredAgentSessionRestartOfferWithdrawal({
      sessions: new Map([[IDENTITY.sessionId, { journal, child: null }]]),
      now: () => clock,
      enqueue: (operation) => operation()
    })

    expect(withdrawal.movedOn(marker)).toBe(false)
  })

  // T-R2B1: the copy committed and only the rename failed. Rows appended since, a restart, and a
  // reopen with the file still there: nothing is imported again, and nothing is lost.
  it('never imports again after a failed rename, across a restart', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    // A non-empty directory where the retired one goes: every rename fails, as a held handle would.
    await mkdir(join(`${legacyDir()}.imported`, 'blocker'), { recursive: true })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const journal = await openChat()
    await journal.appendItem(
      item(2),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after the upgrade' }] },
      { fence: 1 }
    )
    expect(existsSync(legacyJournalDatabaseFile(legacyDir()))).toBe(true)
    // The process exits: the database closes and the owner lock goes with it.
    await journals.closeAll()

    const reopened = await openChat()
    expect(reopened.cursor()).toEqual({ epoch, sequence: rows.length + 1 })
    expect(JSON.stringify(reopened.snapshot().items)).toContain('after the upgrade')

    // The next open retries only the rename, which now succeeds.
    await rm(`${legacyDir()}.imported`, { recursive: true })
    await journals.closeAll()
    await openChat()
    expect(existsSync(legacyDir())).toBe(false)
  })

  // T-import-transient: a read that fails leaves the file for the next open, which imports it.
  it('leaves the file in place on a failed read, and refuses the open rather than serve it empty', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    const database = openTestJournalHostDatabase(root)
    const io = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })

    expect(() =>
      importPerSessionJournal({
        database,
        identity: IDENTITY,
        legacyDirectory: legacyDir(),
        openSource: () => {
          throw io
        }
      })
    ).toThrow(io)
    expect(existsSync(legacyJournalDatabaseFile(legacyDir()))).toBe(true)
    expect(
      database.db.prepare('SELECT count(*) AS total FROM journal_sessions').get()
    ).toMatchObject({ total: 0 })

    const journal = await openChat()
    expect(journal.cursor()).toEqual({ epoch, sequence: rows.length })
    expect(existsSync(legacyDir())).toBe(false)
  })

  // A file that is not a database stays where it is, and the chat says it cannot be loaded.
  it('refuses the open of a legacy file that is not a database, and keeps the file', async () => {
    await mkdir(legacyDir(), { recursive: true })
    await writeFile(legacyJournalDatabaseFile(legacyDir()), 'not a database '.repeat(512))

    await expect(openChat()).rejects.toMatchObject({ errcode: 26 })

    expect(await readdir(legacyDir())).toEqual(['journal.db'])
  })

  it('leaves a never-written file in place until the chat it belongs to is founded', async () => {
    await writeLegacyJournal('unused', [])
    await mkdir(legacyDir(), { recursive: true })
    await writeFile(join(legacyDir(), 'log.jsonl'), '{"kind":"epoch","v":1,"seq":1}\n', 'utf8')

    const journal = await openChat()

    // The pre-SQLite transcript beside it is still there to explain the empty chat.
    expect(JSON.stringify(journal.snapshot().items)).toContain('log.jsonl')
    await journals.closeAll()
    await openChat()
    expect(existsSync(legacyDir())).toBe(false)
  })
})
