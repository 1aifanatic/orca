import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  JOURNAL_BUSY_TIMEOUT_MS,
  JOURNAL_SIZE_LIMIT_BYTES,
  JournalDatabaseNewerSchemaError,
  journalPragmaNumber,
  openJournalDatabase
} from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import {
  allocateJournalBlock,
  deleteJournalBlock,
  deleteJournalRowSuffix,
  insertJournalRow,
  iterateJournalEpochRows,
  JOURNAL_BLOCK_LIMIT,
  JOURNAL_SEQUENCE_LIMIT,
  JournalKeySpaceError,
  journalRowId,
  publishJournalSessionEpoch,
  readJournalRowsAfter,
  readJournalSessionPointer,
  readJournalTip,
  type JournalBlockPointer
} from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'

let root: string
let dbPath: string

function epochRow(seq: number, epoch = 'epoch-1'): JournalRow {
  return {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch,
    seq,
    fence: 0,
    ts: 1_700_000_000_000 + seq
  }
}

const SESSION = { sessionId: 'session-1', workspaceId: 'ws-1' }

function rowsOf(db: Database.Database, pointer: JournalBlockPointer): number[] {
  return [...iterateJournalEpochRows(db, pointer)].map((row) => row.seq)
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-db-'))
  dbPath = journalDatabasePath(root)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('the host journal database open', () => {
  it('creates every table and reads back every load-bearing pragma', () => {
    const db = openJournalDatabase(dbPath)
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((entry) => (entry as { name: string }).name)
      expect(tables).toEqual(
        expect.arrayContaining(['journal_repairs', 'journal_rows', 'journal_sessions'])
      )
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(journalPragmaNumber(db, 'synchronous')).toBe(2)
      expect(journalPragmaNumber(db, 'checkpoint_fullfsync')).toBe(1)
      expect(journalPragmaNumber(db, 'busy_timeout')).toBe(JOURNAL_BUSY_TIMEOUT_MS)
      expect(journalPragmaNumber(db, 'foreign_keys')).toBe(1)
      // 2 is INCREMENTAL, which only takes on an empty file before WAL.
      expect(journalPragmaNumber(db, 'auto_vacuum')).toBe(2)
      expect(journalPragmaNumber(db, 'journal_size_limit')).toBe(JOURNAL_SIZE_LIMIT_BYTES)
      expect(journalPragmaNumber(db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  // T5: a newer build's database is refused and left byte-identical.
  it('refuses a newer user_version without touching the file', async () => {
    const seeded = openJournalDatabase(dbPath)
    publishJournalSessionEpoch(seeded, SESSION, { epoch: 'epoch-1', block: 0 })
    insertJournalRow(seeded, 0, epochRow(1))
    seeded.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 5}`)
    seeded.close()
    const before = await digest(dbPath)

    expect(() => openJournalDatabase(dbPath)).toThrow(JournalDatabaseNewerSchemaError)

    expect(await digest(dbPath)).toBe(before)
    await expect(stat(`${dbPath}-wal`)).rejects.toThrow()
  })

  it('closes the raw connection when schema setup throws', async () => {
    const failing = join(root, 'nested', 'agent-session-journal.db')
    expect(() => openJournalDatabase(failing)).toThrow()
    await expect(stat(`${failing}-wal`)).rejects.toThrow()
    await expect(rm(root, { recursive: true, force: true })).resolves.toBeUndefined()
    root = await mkdtemp(join(tmpdir(), 'orca-journal-db-'))
  })
})

describe('journal row statements', () => {
  it('serves replay, resume, the tip, suffix truncation and a block discard', () => {
    const db = openJournalDatabase(dbPath)
    try {
      const pointer = { epoch: 'epoch-1', block: 0 }
      const other = { epoch: 'epoch-other', block: 1 }
      db.exec('BEGIN IMMEDIATE')
      for (let seq = 1; seq <= 5; seq += 1) {
        insertJournalRow(db, pointer.block, epochRow(seq))
      }
      insertJournalRow(db, other.block, epochRow(1, 'epoch-other'))
      publishJournalSessionEpoch(db, SESSION, pointer)
      publishJournalSessionEpoch(db, { sessionId: 'session-2', workspaceId: 'ws-1' }, other)
      db.exec('COMMIT')

      expect(readJournalSessionPointer(db, 'session-1')).toEqual(pointer)
      expect(readJournalSessionPointer(db, 'absent')).toBeNull()
      expect(rowsOf(db, pointer)).toEqual([1, 2, 3, 4, 5])
      expect(readJournalTip(db, pointer.block)).toBe(5)
      expect(readJournalRowsAfter(db, pointer, 3).map((row) => row.seq)).toEqual([4, 5])

      expect(deleteJournalRowSuffix(db, pointer.block, 4)).toBe(2)
      expect(rowsOf(db, pointer)).toEqual([1, 2, 3])

      // Another chat in the same file is untouched by this chat's discard.
      deleteJournalBlock(db, pointer.block)
      expect(rowsOf(db, pointer)).toEqual([])
      expect(rowsOf(db, other)).toEqual([1])
    } finally {
      db.close()
    }
  })

  it('refuses a duplicate sequence inside one block', () => {
    const db = openJournalDatabase(dbPath)
    try {
      insertJournalRow(db, 0, epochRow(1))
      expect(() => insertJournalRow(db, 0, epochRow(1))).toThrow()
      insertJournalRow(db, 1, epochRow(1))
    } finally {
      db.close()
    }
  })

  it('moves the epoch pointer in place and forgets the saved status with it', () => {
    const db = openJournalDatabase(dbPath)
    try {
      publishJournalSessionEpoch(db, SESSION, { epoch: 'epoch-1', block: 0 })
      db.exec("UPDATE journal_sessions SET status_json = '{}', status_seq = 3")
      publishJournalSessionEpoch(db, SESSION, { epoch: 'epoch-2', block: 1 })
      expect(readJournalSessionPointer(db, 'session-1')).toEqual({ epoch: 'epoch-2', block: 1 })
      expect(
        db
          .prepare('SELECT count(*) AS total, max(status_json) AS status FROM journal_sessions')
          .get()
      ).toMatchObject({ total: 1, status: null })
    } finally {
      db.close()
    }
  })
})

// T-block: the key's bounds, where Number arithmetic has to stay exact.
describe('block keys', () => {
  it('keys the last sequence of the last block exactly, below 2^53', () => {
    const db = openJournalDatabase(dbPath)
    try {
      const pointer = { epoch: 'epoch-1', block: JOURNAL_BLOCK_LIMIT - 1 }
      const seq = JOURNAL_SEQUENCE_LIMIT - 1
      expect(journalRowId(pointer.block, seq)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
      insertJournalRow(db, pointer.block, epochRow(seq))
      insertJournalRow(db, pointer.block - 1, epochRow(seq))
      expect(readJournalRowsAfter(db, pointer, 0).map((row) => row.seq)).toEqual([seq])
      expect(readJournalTip(db, pointer.block)).toBe(seq)
    } finally {
      db.close()
    }
  })

  it('refuses a sequence outside its block, and a block past the last', () => {
    expect(() => journalRowId(0, JOURNAL_SEQUENCE_LIMIT)).toThrow(JournalKeySpaceError)
    expect(() => journalRowId(0, 0)).toThrow(JournalKeySpaceError)
    const db = openJournalDatabase(dbPath)
    try {
      publishJournalSessionEpoch(db, SESSION, { epoch: 'epoch-1', block: JOURNAL_BLOCK_LIMIT - 1 })
      expect(() => allocateJournalBlock(db)).toThrow(JournalKeySpaceError)
    } finally {
      db.close()
    }
  })
})

describe('schema creation', () => {
  it('publishes no table until the version bump commits with it', () => {
    const original = Database.prototype.pragma
    const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: { simple?: boolean }
    ) {
      if (sql.startsWith('user_version =')) {
        throw new Error('crash before the version is published')
      }
      return original.call(this, sql, options)
    })

    expect(() => openJournalDatabase(dbPath)).toThrow('crash before the version is published')
    pragma.mockRestore()

    const inspected = new Database(dbPath)
    try {
      expect(inspected.pragma('user_version', { simple: true })).toBe(0)
      expect(
        inspected
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_rows'")
          .get()
      ).toBeUndefined()
    } finally {
      inspected.close()
    }
  })

  // A database an earlier head of this schema wrote gains the set-aside table and keeps its rows.
  it('upgrades a version 1 database in place', () => {
    const v1 = new Database(dbPath)
    v1.pragma('auto_vacuum = INCREMENTAL')
    v1.pragma('journal_mode = WAL')
    v1.exec(`
CREATE TABLE journal_rows (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, row_json TEXT NOT NULL);
CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL, block INTEGER NOT NULL UNIQUE, status_json TEXT, status_seq INTEGER);
CREATE TABLE journal_repairs (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  content_from INTEGER NOT NULL, repaired_at INTEGER NOT NULL);
CREATE TABLE journal_imports (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, tip INTEGER NOT NULL);
CREATE TABLE journal_import_blocks (session_id TEXT PRIMARY KEY, block INTEGER NOT NULL UNIQUE);
INSERT INTO journal_sessions VALUES ('s1', 'ws', 'e1', 0, NULL, NULL);
INSERT INTO journal_imports VALUES ('s1', 'e0', 3);`)
    v1.pragma('user_version = 1')
    v1.close()

    const db = openJournalDatabase(dbPath)
    try {
      expect(journalPragmaNumber(db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'journal_set_aside'").get()
      ).toBeTruthy()
      expect(db.prepare('SELECT session_id, epoch, tip FROM journal_imports').all()).toEqual([
        { session_id: 's1', epoch: 'e0', tip: 3 }
      ])
      expect(journalPragmaNumber(db, 'auto_vacuum')).toBe(2)
    } finally {
      db.close()
    }
  })
})
