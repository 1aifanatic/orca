// Copying a chat's per-chat journal file into the host's one database, on that chat's open.
//
// Not `journal-legacy-import.ts`, which reads the PROVIDER's own transcript. This reads Orca's own
// earlier `<legacyDir>/journal.db`, verbatim: the same epoch UUID and every sequence number, so a
// cursor, an `acceptedSequence` or a restart offer taken before the upgrade still points at the
// same row after it. A file that reappears after a downgrade is copied again (see
// journal-per-session-reimport.ts).
//
// The rename that retires the source runs only after the copy commits, to a name no earlier
// retirement used. A read that fails leaves the file where it is for the next open, and the open
// is refused rather than served empty: an empty chat founded here would take a new epoch the next
// open's import could not reconcile.

import { existsSync, renameSync } from 'node:fs'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalHostDatabase } from './journal-host-database'
import { legacyJournalDatabaseFile } from './journal-paths'
import {
  planPerSessionImport,
  reimportedJournalRows,
  writePerSessionImportMarker,
  type PerSessionImportPlan,
  type PerSessionJournalHead
} from './journal-per-session-reimport'
import {
  allocateJournalBlock,
  deleteJournalBlock,
  journalRowId,
  publishJournalSessionEpoch,
  readJournalSessionPointer
} from './journal-row-table'

/** The newest per-chat file shape any build wrote. */
const LEGACY_JOURNAL_SCHEMA_VERSION = 2
const LEGACY_ROW_PAGE_SIZE = 512

const SELECT_LEGACY_EPOCH = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
const SELECT_LEGACY_TIP =
  'SELECT max(seq) AS tip FROM journal_rows WHERE session_id = ? AND epoch = ?'
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
  now?: () => number
}

export type PerSessionJournalImportOutcome = 'absent' | 'imported' | 'already-imported'

type ImportInput = {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  legacyDirectory: string
} & PerSessionJournalImportDeps

/** Where a copied directory goes: a name no earlier retirement of the same chat used. */
export function importedLegacyJournalDirectory(
  legacyDirectory: string,
  epoch: string,
  now: number
): string {
  return `${legacyDirectory}.imported-${epoch.slice(0, 8)}-${now}`
}

export function importPerSessionJournal(input: ImportInput): PerSessionJournalImportOutcome {
  const sourcePath = legacyJournalDatabaseFile(input.legacyDirectory)
  if (!existsSync(sourcePath)) {
    return 'absent'
  }
  const { sessionId } = input.identity
  const current = readJournalSessionPointer(input.database.db, sessionId)
  const source = (input.openSource ?? openLegacySource)(sourcePath)
  let legacy: PerSessionJournalHead | null
  let plan: PerSessionImportPlan | null = null
  try {
    legacy = readLegacyHead(source, sessionId)
    if (legacy) {
      plan = planPerSessionImport({ db: input.database.db, sessionId, legacy, current })
      if (plan.kind !== 'copied') {
        copyLegacyJournal(input, source, legacy, plan)
      }
    }
  } finally {
    source.close()
  }
  if (!legacy) {
    // Never written. Left in place while its chat is unfounded: that open's empty chat may still
    // owe the notice about a pre-SQLite transcript beside it.
    if (!current) {
      return 'absent'
    }
    retireImportedDirectory(input, 'unwritten')
    return 'already-imported'
  }
  retireImportedDirectory(input, legacy.epoch)
  return plan?.kind === 'copied' ? 'already-imported' : 'imported'
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

function readLegacyHead(
  source: Database.Database,
  sessionId: string
): PerSessionJournalHead | null {
  const epoch = source.prepare(SELECT_LEGACY_EPOCH).get(sessionId)?.epoch
  if (typeof epoch !== 'string' || epoch.length === 0) {
    return null
  }
  const tip = source.prepare(SELECT_LEGACY_TIP).get(sessionId, epoch)?.tip
  return { epoch, tip: typeof tip === 'number' ? tip : 0 }
}

function* legacyRows(
  source: Database.Database,
  sessionId: string,
  epoch: string
): Generator<{ seq: number; ts: number; rowJson: string }> {
  let afterSeq = Number.MIN_SAFE_INTEGER
  for (;;) {
    const page = source
      .prepare(SELECT_LEGACY_ROWS)
      .all(sessionId, epoch, afterSeq, LEGACY_ROW_PAGE_SIZE)
    for (const row of page) {
      yield { seq: Number(row.seq), ts: Number(row.ts), rowJson: String(row.row_json) }
    }
    const last = page.at(-1)?.seq
    if (page.length < LEGACY_ROW_PAGE_SIZE || typeof last !== 'number') {
      return
    }
    afterSeq = last
  }
}

/** One transaction: the rows, the chat's pointer, its repair marker and the import marker. */
function copyLegacyJournal(
  input: ImportInput,
  source: Database.Database,
  legacy: PerSessionJournalHead,
  plan: Exclude<PerSessionImportPlan, { kind: 'copied' }>
): void {
  const { sessionId } = input.identity
  const epoch = plan.kind === 'again' ? plan.epoch : legacy.epoch
  const repair = readLegacyRepair(source, sessionId)
  // A second copy is read whole: it is rewritten under a fresh epoch or gains a disclosure row.
  const rows =
    plan.kind === 'again'
      ? reimportedJournalRows({
          sessionId,
          legacyEpoch: legacy.epoch,
          epoch,
          rows: [...legacyRows(source, sessionId, legacy.epoch)],
          now: (input.now ?? Date.now)()
        })
      : legacyRows(source, sessionId, legacy.epoch)
  input.database.transaction((db) => {
    const retired = readJournalSessionPointer(db, sessionId)
    const block = allocateJournalBlock(db)
    if (retired) {
      deleteJournalBlock(db, retired.block)
    }
    const insert = db.prepare(INSERT_ROW)
    for (const row of rows) {
      // Copied as stored: the bytes are the row, its epoch and sequence included.
      insert.run(journalRowId(block, row.seq), row.ts, row.rowJson)
    }
    publishJournalSessionEpoch(db, input.identity, { epoch, block })
    if (repair) {
      db.prepare(UPSERT_REPAIR).run(
        sessionId,
        repair.epoch === legacy.epoch ? epoch : repair.epoch,
        repair.content_from,
        repair.repaired_at
      )
    }
    writePerSessionImportMarker(db, sessionId, legacy)
  })
  if (plan.kind === 'again') {
    // The block this copy replaced.
    void input.database.reclaimFreePages()
  }
}

/** The per-chat repair marker, as stored; v1 files predate the table. */
function readLegacyRepair(source: Database.Database, sessionId: string): SqliteRow | null {
  if (!source.prepare(HAS_LEGACY_REPAIRS).get()) {
    return null
  }
  return source.prepare(SELECT_LEGACY_REPAIR).get(sessionId) ?? null
}

/** Best effort: the copy is committed, so a failed rename only leaves a file the next open skips. */
function retireImportedDirectory(input: ImportInput, epoch: string): void {
  const target = importedLegacyJournalDirectory(
    input.legacyDirectory,
    epoch,
    (input.now ?? Date.now)()
  )
  try {
    ;(input.rename ?? renameSync)(input.legacyDirectory, target)
  } catch (error) {
    console.warn(`[agent-session-journal] retiring imported ${input.legacyDirectory} failed`, error)
  }
}
