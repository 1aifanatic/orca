// A chat's per-chat journal file from an earlier build is copied into the host's one database on
// that chat's open: verbatim, and deleted only once the copy reads back as the file. A file that
// reappears after a downgrade and carried the copied epoch on is copied again while this build has
// not written past the copy; any other is set aside on disk, and the chat keeps its history.

import type * as NodeFs from 'node:fs'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import { journalDirectoryFor, legacyJournalDatabaseFile } from './journal-paths'
import { importPerSessionJournal } from './journal-per-session-import'
import { JOURNAL_OLDER_BUILD_DISCLOSURE_IDENTITY } from './journal-per-session-reimport'
import { readJournalSessionPointer, type JournalStoredRow } from './journal-row-table'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, rmSync: vi.fn(actual.rmSync) }
})

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
async function historyRows(
  epoch = 'epoch-from-the-earlier-build',
  reply = 'On it.'
): Promise<{ epoch: string; rows: JournalStoredRow[] }> {
  const scratch = join(root, `scratch-${epoch}`)
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: scratch,
    now: () => (clock += 1),
    mintEpoch: () => epoch
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
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: reply }] },
    { fence: 1 }
  )
  const rows = readTestJournalRows(
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

/** Whatever is left of the chat's per-chat directory, or a copy of it, beside it. */
async function leftovers(): Promise<string[]> {
  const parent = dirname(legacyDir())
  const name = legacyDir().slice(parent.length + 1)
  return existsSync(parent) ? (await readdir(parent)).filter((entry) => entry.startsWith(name)) : []
}

function texts(journal: { snapshot: () => { items: { body: unknown }[] } }): string {
  return JSON.stringify(journal.snapshot().items.map((entry) => entry.body))
}

function rowCount(db: Database.Database): number {
  return Number(db.prepare('SELECT count(*) AS total FROM journal_rows').get()?.total)
}

function removeFails(): void {
  vi.mocked(rmSync).mockImplementation(() => {
    throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
  })
}

async function removeWorks(): Promise<void> {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  vi.mocked(rmSync).mockImplementation(actual.rmSync)
}

/** The file as it is, except that the copy's first read of rows loses the first one. */
function losingFirstCopiedRow(path: string): Database.Database {
  const source = new Database(path, { readonly: true, fileMustExist: true })
  let lost = false
  return new Proxy(source, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (lost || !sql.includes('seq > ?')) {
            return statement
          }
          return new Proxy(statement, {
            get(inner, name) {
              if (name === 'all') {
                return (...args: Parameters<typeof inner.all>) => {
                  lost = true
                  return inner.all(...args).slice(1)
                }
              }
              const value = Reflect.get(inner, name)
              return typeof value === 'function' ? value.bind(inner) : value
            }
          })
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
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
  await removeWorks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('importing a per-chat journal', () => {
  it('copies the history verbatim on first open and deletes the file', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)

    const journal = await openChat()

    expect(journal.epoch).toBe(epoch)
    expect(journal.cursor()).toEqual({ epoch, sequence: rows.length })
    expect(
      readTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId, epoch)
    ).toEqual(rows)
    // Verified, then deleted with its WAL files: no copy of it is kept.
    expect(await leftovers()).toEqual([])
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

  it('copies in batches between turns of the event loop, and publishes the chat with the last', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    const database = openTestJournalHostDatabase(root)
    const turns: { published: boolean; copied: number }[] = []
    let ticking = true
    const tick = (): void => {
      turns.push({
        published: readJournalSessionPointer(database.db, IDENTITY.sessionId) !== null,
        copied: rowCount(database.db)
      })
      if (ticking) {
        setImmediate(tick)
      }
    }
    setImmediate(tick)

    await importPerSessionJournal({
      database,
      identity: IDENTITY,
      legacyDirectory: legacyDir(),
      batchRows: 1
    })
    ticking = false

    // Other work ran while rows were copied, and none of it could see a partly copied chat.
    expect(turns.filter((turn) => !turn.published && turn.copied > 0).length).toBeGreaterThan(0)
    expect(turns.every((turn) => !turn.published || turn.copied === rows.length)).toBe(true)
    expect(readTestJournalRows(database.db, IDENTITY.sessionId, epoch)).toEqual(rows)
  })

  // A quit between two batches: the next open copies the chat again from the start, with no
  // duplicate or leftover row, and no other chat is ever handed the block the copy reserved.
  it('copies a chat again cleanly after a copy stopped midway', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    const database = openTestJournalHostDatabase(root)
    setImmediate(() => closeTestJournalHostDatabases())

    await expect(
      importPerSessionJournal({
        database,
        identity: IDENTITY,
        legacyDirectory: legacyDir(),
        batchRows: 1
      })
    ).rejects.toMatchObject({ code: 'journal_closed' })
    const reopened = openTestJournalHostDatabase(root)
    const reserved = reopened.db.prepare('SELECT block FROM journal_import_blocks').get()?.block
    expect(rowCount(reopened.db)).toBe(1)
    expect(readJournalSessionPointer(reopened.db, IDENTITY.sessionId)).toBeNull()

    const other = await journals.open({
      identity: { ...IDENTITY, sessionId: 'session-other' },
      stateDirectory: root
    })
    await other.appendItem(
      item(1),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'another chat' }] },
      { fence: 1 }
    )
    expect(readJournalSessionPointer(reopened.db, 'session-other')?.block).not.toBe(reserved)
    const journal = await openChat()

    expect(journal.cursor()).toEqual({ epoch, sequence: rows.length })
    expect(readTestJournalRows(reopened.db, IDENTITY.sessionId, epoch)).toEqual(rows)
    expect(rowCount(reopened.db)).toBe(
      rows.length + liveTestJournalRows(reopened.db, 'session-other').length
    )
    expect(
      reopened.db.prepare('SELECT count(*) AS total FROM journal_import_blocks').get()
    ).toEqual({ total: 0 })
  })

  it('copies a chat once when two opens of it import at the same time', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    const database = openTestJournalHostDatabase(root)
    const input = { database, identity: IDENTITY, legacyDirectory: legacyDir(), batchRows: 1 }

    const outcomes = await Promise.all([
      importPerSessionJournal(input),
      importPerSessionJournal(input)
    ])

    expect(outcomes).toEqual(['imported', 'absent'])
    expect(readTestJournalRows(database.db, IDENTITY.sessionId, epoch)).toEqual(rows)
    expect(rowCount(database.db)).toBe(rows.length)
  })

  // Only the copy's own batches skip the fsync: a live chat's write between them, and the publish
  // that makes the batches durable, commit fully synced.
  it('commits copy batches unsynced, and every other commit synced', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    const database = openTestJournalHostDatabase(root)
    const synchronous = () => Number(database.db.pragma('synchronous', { simple: true }))
    const transaction = database.transaction.bind(database)
    const commits: number[] = []
    vi.spyOn(database, 'transaction').mockImplementation((run) =>
      transaction((db) => {
        commits.push(synchronous())
        return run(db)
      })
    )
    const between: number[] = []
    let copying = true
    const tick = (): void => {
      // What a live chat's append would commit under, between two copy batches.
      between.push(synchronous())
      if (copying) {
        setImmediate(tick)
      }
    }

    setImmediate(tick)
    await importPerSessionJournal({
      database,
      identity: IDENTITY,
      legacyDirectory: legacyDir(),
      batchRows: 1
    })
    copying = false

    // 2 is FULL, 1 is NORMAL.
    expect(commits.slice(0, rows.length)).toEqual(rows.map(() => 1))
    expect(commits.at(-1)).toBe(2)
    expect(between.length).toBeGreaterThan(0)
    expect(between.every((value) => value === 2)).toBe(true)
    expect(synchronous()).toBe(2)
  })

  it('ends a copy on a turn of its own, so the open that replays it starts a new task', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    let turns = 0
    const tick = (): void => {
      turns += 1
    }

    setImmediate(tick)
    await importPerSessionJournal({
      database: openTestJournalHostDatabase(root),
      identity: IDENTITY,
      legacyDirectory: legacyDir()
    })

    // One batch copies, and both verify reads are one batch each: only the final yield turns.
    expect(turns).toBe(1)
  })

  it('keeps the file and refuses the chat when the copy does not read back as the file', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    const database = openTestJournalHostDatabase(root)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const input = {
      database,
      identity: IDENTITY,
      legacyDirectory: legacyDir(),
      openSource: losingFirstCopiedRow
    }
    const before = await readFile(legacyJournalDatabaseFile(legacyDir()))

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(importPerSessionJournal(input)).rejects.toMatchObject({
        refusal: { message: 'Unable to load this chat.', details: { reason: 'journalCorrupt' } }
      })
    }

    expect((await readFile(legacyJournalDatabaseFile(legacyDir()))).equals(before)).toBe(true)
    expect(readJournalSessionPointer(database.db, IDENTITY.sessionId)).toBeNull()
    expect(
      database.db.prepare('SELECT count(*) AS total FROM journal_imports').get()
    ).toMatchObject({
      total: 0
    })
    expect(errors).toHaveBeenCalledOnce()
    // A copy that reads back whole then imports it, over what the refused ones left.
    const journal = await openChat()
    expect(readTestJournalRows(database.db, IDENTITY.sessionId, epoch)).toEqual(rows)
    expect(journal.cursor()).toEqual({ epoch, sequence: rows.length })
    expect(rowCount(database.db)).toBe(rows.length)
  })

  // T-R2B1: the copy committed and only the delete failed (a crash between them is the same). Rows appended since, a restart, and a
  // reopen with the file still there: nothing is copied again, and nothing is lost.
  it('never copies the same file again after a failed delete, and deletes it on the next open', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    removeFails()
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
    await removeWorks()

    const reopened = await openChat()
    expect(reopened.cursor()).toEqual({ epoch, sequence: rows.length + 1 })
    expect(texts(reopened)).toContain('after the upgrade')
    expect(texts(reopened)).not.toContain(JOURNAL_OLDER_BUILD_DISCLOSURE_IDENTITY.clientMessageId)
    expect(await leftovers()).toEqual([])
  })

  // T-import-transient: a read that fails leaves the file for the next open, which imports it.
  it('leaves the file in place on a failed read, and refuses the open rather than serve it empty', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    const database = openTestJournalHostDatabase(root)
    const io = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })

    await expect(
      importPerSessionJournal({
        database,
        identity: IDENTITY,
        legacyDirectory: legacyDir(),
        openSource: () => {
          throw io
        }
      })
    ).rejects.toThrow(io)
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
    // The journal file goes; the transcript is the user's, and stays.
    expect(await readdir(legacyDir())).toEqual(['log.jsonl'])
  })

  // A crash between creating the file and giving it the schema: the chat opens with no history, as
  // it did when each chat opened its own file, and the file is deleted like any never-written one.
  it.each([
    ['empty', async (path: string) => writeFile(path, '')],
    [
      'schema-less',
      async (path: string) => {
        const db = new Database(path)
        db.pragma('journal_mode = WAL')
        db.close()
      }
    ]
  ])('opens a chat whose per-chat file is %s as having no history', async (_shape, create) => {
    await mkdir(legacyDir(), { recursive: true })
    await create(legacyJournalDatabaseFile(legacyDir()))

    const journal = await openChat()

    expect(journal.snapshot().items).toEqual([])
    await journals.closeAll()
    await openChat()
    expect(await leftovers()).toEqual([])
  })

  // F-L6-1: the copy deleted the file, so the older build found none and started the chat over.
  // The re-upgrade must neither let that start replace the history nor delete what it wrote.
  it('keeps the history, and the older build’s file untouched, after a downgrade round trip', async () => {
    const first = await historyRows('epoch-original', 'ORIGINAL HISTORY')
    await writeLegacyJournal(first.epoch, first.rows)
    expect(texts(await openChat())).toContain('ORIGINAL HISTORY')
    await journals.closeAll()
    expect(existsSync(legacyDir())).toBe(false)
    const older = await historyRows('epoch-older-fresh', 'typed in the older build')
    await writeLegacyJournal(older.epoch, older.rows)
    const file = legacyJournalDatabaseFile(legacyDir())
    const bytes = await readFile(file)

    for (let open = 0; open < 2; open += 1) {
      const reopened = await openChat()
      expect(reopened.epoch).toBe(first.epoch)
      expect(texts(reopened)).toContain('ORIGINAL HISTORY')
      expect(texts(reopened)).not.toContain('typed in the older build')
      expect(texts(reopened)).not.toContain('continued in an older version of Orca')
      await journals.closeAll()
    }
    const database = openTestJournalHostDatabase(root)
    expect(readTestJournalRows(database.db, IDENTITY.sessionId, first.epoch)).toEqual(first.rows)
    expect((await readFile(file)).equals(bytes)).toBe(true)
    const kept = new Database(file, { readonly: true })
    const keptRows = kept.prepare('SELECT seq, ts, row_json FROM journal_rows ORDER BY seq').all()
    kept.close()
    expect(keptRows.map((row) => row.row_json)).toEqual(older.rows.map((row) => row.rowJson))
  })

  // The older build started over and then rewound, so its file's epoch opens `handle_forked`: it
  // still never held this build's history, and is set aside like any other epoch.
  it('keeps the history when the older build rewound the chat it started over', async () => {
    const first = await historyRows('epoch-original', 'ORIGINAL HISTORY')
    await writeLegacyJournal(first.epoch, first.rows)
    await openChat()
    await journals.closeAll()
    const older = await historyRows('epoch-older-rewound', 'typed in the older build')
    const opening = JSON.parse(older.rows[0]!.rowJson)
    expect(opening).toMatchObject({ kind: 'epoch', reason: 'session_created' })
    const rewound = [
      { ...older.rows[0]!, rowJson: JSON.stringify({ ...opening, reason: 'handle_forked' }) },
      ...older.rows.slice(1)
    ]
    await writeLegacyJournal(older.epoch, rewound)
    const bytes = await readFile(legacyJournalDatabaseFile(legacyDir()))

    const reopened = await openChat()

    expect(reopened.epoch).toBe(first.epoch)
    expect(texts(reopened)).toContain('ORIGINAL HISTORY')
    expect(texts(reopened)).not.toContain('typed in the older build')
    expect((await readFile(legacyJournalDatabaseFile(legacyDir()))).equals(bytes)).toBe(true)
  })

  // The one file at another epoch that did descend from the copy: its delete failed and the older
  // build rolled the epoch of the file it kept. It is set aside too; nothing this build has is lost.
  it('sets aside a kept file the older build rolled to a new epoch', async () => {
    const first = await historyRows('epoch-original', 'ORIGINAL HISTORY')
    await writeLegacyJournal(first.epoch, first.rows)
    removeFails()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await openChat()
    await journals.closeAll()
    await removeWorks()
    const rolled = await historyRows('epoch-rolled-by-older', 'rolled in the older build')
    await rm(legacyDir(), { recursive: true, force: true })
    await writeLegacyJournal(rolled.epoch, rolled.rows)

    const reopened = await openChat()

    expect(reopened.epoch).toBe(first.epoch)
    expect(texts(reopened)).toContain('ORIGINAL HISTORY')
    expect(texts(reopened)).not.toContain('rolled in the older build')
    expect(existsSync(legacyJournalDatabaseFile(legacyDir()))).toBe(true)
  })

  // A chat this build founded has a pointer and no import marker: an older build that then starts
  // a per-chat file for it never held this build's history, so the file is set aside.
  it('keeps a chat founded in this build when an older build starts a per-chat file for it', async () => {
    const founded = await openChat()
    await founded.appendItem(
      item(1),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'FOUNDED HERE' }] },
      { fence: 1 }
    )
    const foundedEpoch = founded.epoch
    await journals.closeAll()
    const older = await historyRows('epoch-older-fresh', 'typed in the older build')
    await writeLegacyJournal(older.epoch, older.rows)
    const bytes = await readFile(legacyJournalDatabaseFile(legacyDir()))

    const reopened = await openChat()

    expect(reopened.epoch).toBe(foundedEpoch)
    expect(texts(reopened)).toContain('FOUNDED HERE')
    expect(texts(reopened)).not.toContain('typed in the older build')
    expect((await readFile(legacyJournalDatabaseFile(legacyDir()))).equals(bytes)).toBe(true)
  })

  // Decided once and recorded: no later open reads the file again, after a restart or after the
  // older build ran again and wrote more to it.
  it('never reads a set-aside file again', async () => {
    const first = await historyRows('epoch-original', 'ORIGINAL HISTORY')
    await writeLegacyJournal(first.epoch, first.rows)
    await openChat()
    await journals.closeAll()
    const older = await historyRows('epoch-older-fresh', 'typed in the older build')
    await writeLegacyJournal(older.epoch, older.rows)
    const reads: string[] = []
    const countingSource = (path: string) => {
      reads.push(path)
      return new Database(path, { readonly: true, fileMustExist: true })
    }
    const importAgain = () =>
      importPerSessionJournal({
        database: openTestJournalHostDatabase(root),
        identity: IDENTITY,
        legacyDirectory: legacyDir(),
        openSource: countingSource
      })

    expect(await importAgain()).toBe('kept')
    expect(reads).toHaveLength(1)
    closeTestJournalHostDatabases()
    expect(await importAgain()).toBe('kept')
    const row = { ...JSON.parse(older.rows.at(-1)!.rowJson), seq: older.rows.length + 1 }
    const legacy = new Database(legacyJournalDatabaseFile(legacyDir()))
    legacy
      .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
      .run(IDENTITY.sessionId, older.epoch, row.seq, 1, JSON.stringify(row))
    legacy.close()
    expect(await importAgain()).toBe('kept')

    expect(reads).toHaveLength(1)
    expect(texts(await openChat())).toContain('ORIGINAL HISTORY')
    expect(existsSync(legacyJournalDatabaseFile(legacyDir()))).toBe(true)
  })

  // T-B5: a downgrade, an older build starting the chat over in a new per-chat file, and a
  // re-upgrade — twice. This build's history stays whole each time, and the file stays on disk.
  it('keeps this build’s history on every re-upgrade after an older build started the chat over', async () => {
    const first = await historyRows('epoch-original', 'ORIGINAL HISTORY')
    await writeLegacyJournal(first.epoch, first.rows)
    const upgraded = await openChat()
    await upgraded.appendItem(
      item(2),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'this build' }] },
      { fence: 1 }
    )
    await journals.closeAll()
    const older = await historyRows('epoch-downgrade', 'older build, cycle 1')
    await writeLegacyJournal(older.epoch, older.rows)

    for (const cycle of [1, 2]) {
      if (cycle === 2) {
        // The second downgrade finds the file it wrote the first time, and carries it on.
        const row = { ...JSON.parse(older.rows.at(-1)!.rowJson), seq: older.rows.length + 1 }
        row.body = {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'cycle 2' }]
        }
        const legacy = new Database(legacyJournalDatabaseFile(legacyDir()))
        legacy
          .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
          .run(IDENTITY.sessionId, older.epoch, row.seq, 1, JSON.stringify(row))
        legacy.close()
      }
      const reopened = await openChat()
      expect(reopened.epoch).toBe(first.epoch)
      expect(texts(reopened)).toContain('ORIGINAL HISTORY')
      expect(texts(reopened)).toContain('this build')
      expect(texts(reopened)).not.toContain('older build, cycle 1')
      expect(texts(reopened)).not.toContain('cycle 2')
      expect(texts(reopened)).not.toContain('continued in an older version of Orca')
      expect(existsSync(legacyJournalDatabaseFile(legacyDir()))).toBe(true)
      await journals.closeAll()
    }
  })

  // The delete failed, so the older build found the copied file and carried its epoch on, while
  // this build wrote nothing past the copy: the file is the copied history plus the older build's
  // rows, copied again under the same epoch, with the row that says so.
  it('copies again a file an older build carried on under the copied epoch', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    removeFails()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await openChat()
    await journals.closeAll()
    appendOlderRow(epoch, rows, rows.length + 1)
    await removeWorks()

    const reopened = await openChat()

    expect(reopened.epoch).toBe(epoch)
    expect(texts(reopened)).toContain('older')
    expect(texts(reopened)).toContain('continued in an older version of Orca')
    expect(existsSync(legacyDir())).toBe(false)
  })

  /** The older build appends one row to the per-chat file the failed delete left, at its epoch. */
  function appendOlderRow(epoch: string, rows: readonly JournalStoredRow[], seq: number): void {
    const olderRow = { ...JSON.parse(rows.at(-1)!.rowJson), seq }
    olderRow.body = {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'older' }]
    }
    olderRow.itemId = `${olderRow.itemId}-older`
    const legacy = new Database(legacyJournalDatabaseFile(legacyDir()))
    legacy
      .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
      .run(IDENTITY.sessionId, epoch, seq, 1, JSON.stringify(olderRow))
    legacy.close()
  }

  function sharedRowsContaining(text: string): number {
    return openTestJournalHostDatabase(root)
      .db.prepare('SELECT row_json FROM journal_rows')
      .all()
      .filter((row) => String(row.row_json).includes(text)).length
  }

  // N-R3.1: the delete failed, this build appended, and an older build then appended to that same
  // file. Copying the file again would replace what this build wrote, so it is set aside.
  it('keeps this build’s history, and the older file untouched, when both builds wrote past the copy', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    removeFails()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const journal = await openChat()
    await journal.appendItem(
      item(2),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'this build' }] },
      { fence: 1 }
    )
    await journals.closeAll()
    appendOlderRow(epoch, rows, rows.length + 1)
    const bytes = await readFile(legacyJournalDatabaseFile(legacyDir()))
    await removeWorks()

    const reopened = await openChat()

    expect(reopened.epoch).toBe(epoch)
    expect(texts(reopened)).toContain('this build')
    expect(texts(reopened)).not.toContain('older')
    expect(texts(reopened)).not.toContain('continued in an older version of Orca')
    expect(sharedRowsContaining('this build')).toBeGreaterThan(0)
    expect((await readFile(legacyJournalDatabaseFile(legacyDir()))).equals(bytes)).toBe(true)
  })

  // This build rolled its epoch after the copy (a rewind), and the older build then carried the
  // leftover file on under the copied epoch: the file no longer holds what this build has. The new
  // epoch restarts its sequence, so this build's tip is brought level with the recorded one.
  it('keeps this build’s history when it rolled its epoch after the copy', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    removeFails()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const journal = await openChat()
    let cursor = await journal.rollEpoch('handle_forked', 1)
    for (let ordinal = 3; cursor.sequence < rows.length; ordinal += 1) {
      const appended = await journal.appendItem(
        item(ordinal),
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'after the rewind' }]
        },
        { fence: 1 }
      )
      cursor = appended.cursor
    }
    expect(cursor.sequence).toBe(rows.length)
    const rolledEpoch = journal.epoch
    await journals.closeAll()
    appendOlderRow(epoch, rows, rows.length + 1)
    const bytes = await readFile(legacyJournalDatabaseFile(legacyDir()))
    await removeWorks()

    const reopened = await openChat()

    expect(rolledEpoch).not.toBe(epoch)
    expect(reopened.epoch).toBe(rolledEpoch)
    expect(texts(reopened)).toContain('after the rewind')
    expect(texts(reopened)).not.toContain('older')
    expect(texts(reopened)).not.toContain('continued in an older version of Orca')
    expect((await readFile(legacyJournalDatabaseFile(legacyDir()))).equals(bytes)).toBe(true)
  })
})
