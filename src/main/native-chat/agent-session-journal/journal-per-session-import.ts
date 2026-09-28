// Copying a chat's per-chat journal file into the host's one database, on that chat's first open.
//
// Not `journal-legacy-import.ts`, which reads the PROVIDER's own transcript. This reads Orca's own
// earlier `<legacyDir>/journal.db`, verbatim: the same epoch UUID and every sequence number, so a
// cursor, an `acceptedSequence` or a restart offer taken before the upgrade still points at the
// same row after it.
//
// The rename that retires the source runs only after the copy commits. A read that fails leaves
// the file where it is for the next open, and the open is refused rather than served empty: an
// empty chat founded here would take a new epoch the next open's import could not reconcile.

import { existsSync, renameSync } from 'node:fs'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalHostDatabase } from './journal-host-database'
import { legacyJournalDatabaseFile } from './journal-paths'
import {
  allocateJournalBlock,
  deleteJournalBlock,
  journalRowId,
  publishJournalSessionEpoch,
  readJournalSessionEpoch,
  readJournalSessionPointer
} from './journal-row-table'

/** The newest per-chat file shape any build wrote. */
const LEGACY_JOURNAL_SCHEMA_VERSION = 2
const LEGACY_ROW_PAGE_SIZE = 512

const SELECT_LEGACY_EPOCH = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
const SELECT_LEGACY_ROWS = `SELECT seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
const HAS_LEGACY_REPAIRS =
  "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'journal_repairs'"
const SELECT_LEGACY_REPAIR =
  'SELECT epoch, content_from, repaired_at FROM journal_repairs WHERE session_id = ?'
const INSERT_ROW = 'INSERT INTO journal_rows (id, ts, row_json) VALUES (?, ?, ?)'
const UPSERT_REPAIR = `INSERT INTO journal_repairs (session_id, epoch, content_from, repaired_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  epoch = excluded.epoch, content_from = excluded.content_from, repaired_at = excluded.repaired_at`

export type PerSessionJournalImportDeps = {
  openSource?: (path: string) => Database.Database
  rename?: (from: string, to: string) => void
}

export type PerSessionJournalImportOutcome = 'absent' | 'imported' | 'already-imported'

/** The name a copied directory is moved to, so nothing reads it again. */
export function importedLegacyJournalDirectory(legacyDirectory: string): string {
  return `${legacyDirectory}.imported`
}

export function importPerSessionJournal(
  input: {
    database: JournalHostDatabase
    identity: AgentSessionJournalIdentity
    legacyDirectory: string
  } & PerSessionJournalImportDeps
): PerSessionJournalImportOutcome {
  const sourcePath = legacyJournalDatabaseFile(input.legacyDirectory)
  if (!existsSync(sourcePath)) {
    return 'absent'
  }
  // Import once: a chat that already has a journal here was copied, and only its rename failed.
  if (readJournalSessionEpoch(input.database.db, input.identity.sessionId) !== null) {
    retireImportedDirectory(input)
    return 'already-imported'
  }
  const source = (input.openSource ?? openLegacySource)(sourcePath)
  let copied: boolean
  try {
    copied = copyLegacyJournal(input, source)
  } finally {
    source.close()
  }
  if (!copied) {
    // Never written. Left in place for this open, whose empty chat may still owe the notice about
    // a pre-SQLite transcript beside it; the next open finds the chat founded and retires it.
    return 'absent'
  }
  retireImportedDirectory(input)
  return 'imported'
}

/** A plain read-only connection: it sees committed WAL frames without checkpointing them. */
function openLegacySource(path: string): Database.Database {
  const source = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const version = Number(source.pragma('user_version', { simple: true }) ?? 0)
    if (version > LEGACY_JOURNAL_SCHEMA_VERSION) {
      throw new Error(`per-chat journal ${path} uses schema ${version}, which no build wrote`)
    }
    return source
  } catch (error) {
    source.close()
    throw error
  }
}

function copyLegacyJournal(
  input: { database: JournalHostDatabase; identity: AgentSessionJournalIdentity },
  source: Database.Database
): boolean {
  const { sessionId } = input.identity
  const epoch = source.prepare(SELECT_LEGACY_EPOCH).get(sessionId)?.epoch
  if (typeof epoch !== 'string' || epoch.length === 0) {
    return false
  }
  const repair = readLegacyRepair(source, sessionId)
  input.database.transaction((db) => {
    const retired = readJournalSessionPointer(db, sessionId)
    const block = allocateJournalBlock(db)
    if (retired) {
      deleteJournalBlock(db, retired.block)
    }
    const insert = db.prepare(INSERT_ROW)
    let afterSeq = Number.MIN_SAFE_INTEGER
    for (;;) {
      const page = source
        .prepare(SELECT_LEGACY_ROWS)
        .all(sessionId, epoch, afterSeq, LEGACY_ROW_PAGE_SIZE)
      for (const row of page) {
        // Copied as stored: the bytes are the row, its epoch and sequence included.
        insert.run(journalRowId(block, Number(row.seq)), row.ts, row.row_json)
      }
      const last = page.at(-1)?.seq
      if (page.length < LEGACY_ROW_PAGE_SIZE || typeof last !== 'number') {
        break
      }
      afterSeq = last
    }
    publishJournalSessionEpoch(db, input.identity, { epoch, block })
    if (repair) {
      db.prepare(UPSERT_REPAIR).run(
        sessionId,
        repair.epoch,
        repair.content_from,
        repair.repaired_at
      )
    }
  })
  return true
}

/** The per-chat repair marker, as stored; v1 files predate the table. */
function readLegacyRepair(source: Database.Database, sessionId: string): SqliteRow | null {
  if (!source.prepare(HAS_LEGACY_REPAIRS).get()) {
    return null
  }
  return source.prepare(SELECT_LEGACY_REPAIR).get(sessionId) ?? null
}

/** Best effort: the copy is committed, so a failed rename only leaves a file the next open skips. */
function retireImportedDirectory(input: {
  legacyDirectory: string
  rename?: (from: string, to: string) => void
}): void {
  const target = importedLegacyJournalDirectory(input.legacyDirectory)
  try {
    ;(input.rename ?? renameSync)(input.legacyDirectory, target)
  } catch (error) {
    console.warn(`[agent-session-journal] retiring imported ${input.legacyDirectory} failed`, error)
  }
}
