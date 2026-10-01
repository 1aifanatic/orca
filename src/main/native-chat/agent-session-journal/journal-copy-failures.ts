// Background copies of a per-chat file that failed in a way no retry reads past: a file that will
// not open, or a copy that did not read back as the file. Each is keyed to the file as the failing
// read left it, size and mtime of `journal.db` and of its `-wal`, plus the app version, so the
// background copy skips it while all of that holds. Any change (an older build writing, a
// checkpoint, an update) makes the chat owed again, for one more try. A user's own open of the chat
// still tries the copy, as it always did.
//
// Created at every writable open with no `user_version` bump, as the stored chat state is: an older
// build ignores it and stays writable.

import { statSync } from 'node:fs'
import { isTransientSqliteContention } from '../../sqlite/sqlite-read-failure'
import type Database from '../../sqlite/sync-database'
import { JournalImportAbortedError } from './journal-open-failure'
import { legacyJournalDatabaseFile } from './journal-paths'

/** How a copy failed: stopped for quit, likely to clear on a later try, or not. */
export type JournalCopyFailureKind = 'aborted' | 'transient' | 'deterministic'

const SQLITE_IOERR = 10
const SQLITE_FULL = 13
const TRANSIENT_FS_CODES = new Set(['ENOSPC', 'EBUSY', 'EMFILE', 'ENFILE', 'EIO', 'EAGAIN'])
const MAX_CAUSE_DEPTH = 8

export function classifyJournalCopyFailure(error: unknown): JournalCopyFailureKind {
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof JournalImportAbortedError) {
      return 'aborted'
    }
    if (isTransientSqliteContention(current) || isTransientIoFailure(current)) {
      return 'transient'
    }
    current = current.cause
  }
  return 'deterministic'
}

function isTransientIoFailure(error: Error): boolean {
  const errcode = 'errcode' in error ? error.errcode : undefined
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff
    return primary === SQLITE_IOERR || primary === SQLITE_FULL
  }
  return 'code' in error && typeof error.code === 'string' && TRANSIENT_FS_CODES.has(error.code)
}

export function ensureJournalCopyFailuresTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS journal_copy_failures (
  session_id   TEXT    PRIMARY KEY,
  db_size      INTEGER NOT NULL,
  db_mtime_ms  INTEGER NOT NULL,
  wal_size     INTEGER,
  wal_mtime_ms INTEGER,
  app_version  TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  failed_at    INTEGER NOT NULL
);
`)
}

/** A per-chat file as it stands on disk; a missing `-wal` is a value of its own. */
export type PerChatFileState = {
  dbSize: number
  dbMtimeMs: number
  walSize: number | null
  walMtimeMs: number | null
}

/** Null when the chat's `journal.db` is gone. */
export function statPerChatFile(legacyDirectory: string): PerChatFileState | null {
  const file = legacyJournalDatabaseFile(legacyDirectory)
  const database = statSync(file, { throwIfNoEntry: false })
  if (!database) {
    return null
  }
  const wal = statSync(`${file}-wal`, { throwIfNoEntry: false })
  return {
    dbSize: database.size,
    dbMtimeMs: Math.trunc(database.mtimeMs),
    walSize: wal ? wal.size : null,
    walMtimeMs: wal ? Math.trunc(wal.mtimeMs) : null
  }
}

export function samePerChatFileState(
  left: PerChatFileState | null,
  right: PerChatFileState | null
): boolean {
  return (
    left?.dbSize === right?.dbSize &&
    left?.dbMtimeMs === right?.dbMtimeMs &&
    left?.walSize === right?.walSize &&
    left?.walMtimeMs === right?.walMtimeMs
  )
}

const UPSERT_FAILURE = `INSERT INTO journal_copy_failures (session_id, db_size, db_mtime_ms, wal_size,
  wal_mtime_ms, app_version, reason, failed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  db_size = excluded.db_size, db_mtime_ms = excluded.db_mtime_ms, wal_size = excluded.wal_size,
  wal_mtime_ms = excluded.wal_mtime_ms, app_version = excluded.app_version,
  reason = excluded.reason, failed_at = excluded.failed_at`
const SELECT_FAILURE = `SELECT db_size, db_mtime_ms, wal_size, wal_mtime_ms, app_version
FROM journal_copy_failures WHERE session_id = ?`
const DELETE_FAILURE = 'DELETE FROM journal_copy_failures WHERE session_id = ?'

/** Keyed to the file as the failing read left it, so a file that moved since is tried again.
 *  Bookkeeping: a failure to record is logged, and only costs one more try. */
export function recordJournalCopyFailure(
  db: Database.Database,
  input: {
    sessionId: string
    legacyDirectory: string
    appVersion: string
    error: unknown
    failedAt: number
  }
): void {
  try {
    const file = statPerChatFile(input.legacyDirectory)
    if (!file) {
      return
    }
    db.prepare(UPSERT_FAILURE).run(
      input.sessionId,
      file.dbSize,
      file.dbMtimeMs,
      file.walSize,
      file.walMtimeMs,
      input.appVersion,
      input.error instanceof Error ? input.error.message : String(input.error),
      input.failedAt
    )
  } catch (error) {
    console.warn('[agent-session-journal] recording a failed chat file copy failed', error)
  }
}

/** Whether the chat's last recorded failure was of this very file, under this app version. */
export function journalCopyFailureStands(
  db: Database.Database,
  sessionId: string,
  file: PerChatFileState,
  appVersion: string
): boolean {
  const row = db.prepare(SELECT_FAILURE).get(sessionId)
  if (!row || row.app_version !== appVersion) {
    return false
  }
  return samePerChatFileState(file, {
    dbSize: Number(row.db_size),
    dbMtimeMs: Number(row.db_mtime_ms),
    walSize: row.wal_size === null ? null : Number(row.wal_size),
    walMtimeMs: row.wal_mtime_ms === null ? null : Number(row.wal_mtime_ms)
  })
}

export function deleteJournalCopyFailure(db: Database.Database, sessionId: string): void {
  db.prepare(DELETE_FAILURE).run(sessionId)
}

/** The file is gone, so its give-up is too. Reads first: most chats never had one to delete. */
export function forgetJournalCopyFailure(db: Database.Database, sessionId: string): void {
  if (db.prepare(SELECT_FAILURE).get(sessionId)) {
    deleteJournalCopyFailure(db, sessionId)
  }
}
