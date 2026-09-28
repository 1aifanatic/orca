// Opening the host's chat journal database.
//
// `PRAGMA user_version` is read FIRST, on a connection that has set no persistent pragma and run
// no DDL: a database written by a newer schema must be left byte-identical, and
// `journal_mode = WAL` writes the file header.

import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { createJournalTablesSql, JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'

export const JOURNAL_BUSY_TIMEOUT_MS = 5000
/** Bounds the WAL a checkpoint leaves behind; SQLite truncates it back to this after a reset. */
export const JOURNAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024

/** A newer build wrote this database: this build neither reads nor writes it. */
export class JournalDatabaseNewerSchemaError extends Error {
  constructor(
    readonly storedVersion: number,
    dbPath: string
  ) {
    super(
      `chat journal ${dbPath} uses schema ${storedVersion}; this build knows only up to ${JOURNAL_DB_SCHEMA_VERSION}`
    )
    this.name = 'JournalDatabaseNewerSchemaError'
  }
}

export function journalPragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

export function openJournalDatabase(dbPath: string): Database.Database {
  const probe = new Database(dbPath)
  let transferred = false
  try {
    const stored = journalPragmaNumber(probe, 'user_version')
    if (stored > JOURNAL_DB_SCHEMA_VERSION) {
      throw new JournalDatabaseNewerSchemaError(stored, dbPath)
    }
    configureJournalPragmas(probe, stored)
    createJournalSchema(probe, stored)
    hardenSqliteDatabaseFiles(dbPath)
    transferred = true
    return probe
  } finally {
    if (!transferred) {
      probe.close()
    }
  }
}

function configureJournalPragmas(db: Database.Database, stored: number): void {
  if (stored === 0) {
    // Only takes on an empty file, and only before WAL: it is what lets freed pages go back in
    // bounded steps rather than a full VACUUM, which could never be switched on later.
    db.pragma('auto_vacuum = INCREMENTAL')
  }
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
  db.pragma('foreign_keys = ON')
  // Why FULL rather than the house NORMAL: NORMAL in WAL mode does not fsync at commit, and the
  // write-ahead submission row must be on disk before the adapter dispatches anything. FULL alone
  // does not survive power loss on macOS, whose fsync leaves the drive cache unflushed; checkpoint
  // fullfsync makes each checkpoint use F_FULLFSYNC (a no-op elsewhere).
  db.pragma('synchronous = FULL')
  db.pragma('checkpoint_fullfsync = ON')
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`)
}

/**
 * Table creation and the `user_version` bump are ONE transaction. Creating the tables first left
 * a shaped database still reporting version 0, which an older build does not latch read-only.
 */
function createJournalSchema(db: Database.Database, stored: number): void {
  if (stored >= JOURNAL_DB_SCHEMA_VERSION) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(createJournalTablesSql())
    db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
