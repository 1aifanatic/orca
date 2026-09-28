// A chat's per-chat journal file from an earlier build is copied into the host's one database on
// that chat's open: verbatim, and deleted only once the copy reads back as the file. A file that
// reappears after a downgrade is the newer history, and is copied again.

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

  // T-B5: a downgrade, an older build writing the chat's history to a new per-chat file, and a
  // re-upgrade — twice. The newer history wins each time, says so, and each file is deleted.
  it('copies the newer history an older build wrote, on every re-upgrade', async () => {
    const first = await historyRows()
    await writeLegacyJournal(first.epoch, first.rows)
    const upgraded = await openChat()
    await upgraded.appendItem(
      item(2),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'this build' }] },
      { fence: 1 }
    )
    await journals.closeAll()

    for (const [cycle, epoch] of ['epoch-downgrade-one', 'epoch-downgrade-two'].entries()) {
      const older = await historyRows(epoch, `older build, cycle ${cycle + 1}`)
      await writeLegacyJournal(older.epoch, older.rows)
      await journals.closeAll()

      const reopened = await openChat()
      expect(reopened.epoch).toBe(epoch)
      expect(texts(reopened)).toContain(`older build, cycle ${cycle + 1}`)
      expect(texts(reopened)).not.toContain('this build')
      expect(texts(reopened)).toContain('continued in an older version of Orca')
      expect(existsSync(legacyDir())).toBe(false)
      await journals.closeAll()
    }
    expect(await leftovers()).toEqual([])
  })

  // N-R3.1: the delete failed, this build appended, and an older build then appended to that same
  // file. Both advanced from the recorded tip under one epoch, so the copy takes a fresh one: a
  // reader at this build's tip resets instead of silently skipping the older build's rows.
  it('gives the copy a fresh epoch when both builds wrote past the same recorded tip', async () => {
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
    const olderRow = { ...JSON.parse(rows.at(-1)!.rowJson), seq: rows.length + 1 }
    olderRow.body = {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'older' }]
    }
    olderRow.itemId = `${olderRow.itemId}-older`
    const legacy = new Database(legacyJournalDatabaseFile(legacyDir()))
    legacy
      .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
      .run(IDENTITY.sessionId, epoch, rows.length + 1, 1, JSON.stringify(olderRow))
    legacy.close()
    await removeWorks()

    const reopened = await openChat()

    expect(reopened.epoch).not.toBe(epoch)
    expect(texts(reopened)).toContain('older')
    expect(texts(reopened)).toContain('continued in an older version of Orca')
    expect(reopened.readSince({ epoch, sequence: rows.length + 1 })).toEqual({
      ok: false,
      reset: 'epoch_changed'
    })
    expect(existsSync(legacyDir())).toBe(false)
  })
})
