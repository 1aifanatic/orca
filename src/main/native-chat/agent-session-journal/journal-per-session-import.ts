// Copying a chat's per-chat journal file into the host's one database, on that chat's open.
//
// Not `journal-legacy-import.ts`, which reads the PROVIDER's own transcript. This reads Orca's own
// earlier `<legacyDir>/journal.db`, verbatim: the same epoch UUID and every sequence number, so a
// cursor, an `acceptedSequence` or a restart offer taken before the upgrade still points at the
// same row after it. A file that reappears after a downgrade is copied again (see
// journal-per-session-reimport.ts).
//
// The copy runs in bounded batches, each its own transaction, yielding the event loop between them.
// The rows go into a block `journal_import_blocks` reserves, which no reader follows: the chat's
// pointer, its repair and import markers land in the last batch, so the chat is imported all at once
// or not at all. A try that stops midway leaves only that reserved block, which the next try clears
// and copies again.
//
// The rename that retires the source runs only after the copy commits, to a name no earlier
// retirement used. A read that fails leaves the file where it is for the next open, and the open
// is refused rather than served empty: an empty chat founded here would take a new epoch the next
// open's import could not reconcile.

import { existsSync, renameSync } from 'node:fs'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
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
/** Rows per batch: at most 31 ms per batch copying the largest real chat (68 MB, 3.3 KB rows). */
const IMPORT_BATCH_ROWS = 512

const SELECT_LEGACY_EPOCH = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
const SELECT_LEGACY_TIP =
  'SELECT max(seq) AS tip FROM journal_rows WHERE session_id = ? AND epoch = ?'
const SELECT_LEGACY_ROWS = `SELECT seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
const HAS_LEGACY_TABLE = "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
const SELECT_LEGACY_REPAIR =
  'SELECT epoch, content_from, repaired_at FROM journal_repairs WHERE session_id = ?'
const INSERT_ROW = 'INSERT INTO journal_rows (id, ts, row_json) VALUES (?, ?, ?)'
const SELECT_IMPORT_BLOCK = 'SELECT block FROM journal_import_blocks WHERE session_id = ?'
const RESERVE_IMPORT_BLOCK = 'INSERT INTO journal_import_blocks (session_id, block) VALUES (?, ?)'
const RELEASE_IMPORT_BLOCK = 'DELETE FROM journal_import_blocks WHERE session_id = ?'
const UPSERT_REPAIR = `INSERT INTO journal_repairs (session_id, epoch, content_from, repaired_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  epoch = excluded.epoch, content_from = excluded.content_from, repaired_at = excluded.repaired_at`

export type PerSessionJournalImportDeps = {
  openSource?: (path: string) => Database.Database
  rename?: (from: string, to: string) => void
  now?: () => number
  batchRows?: number
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

/** Imports in flight, by database and chat: a second open of the same chat waits for the first. */
const importsInFlight = new WeakMap<JournalHostDatabase, Map<string, Promise<unknown>>>()

export function importPerSessionJournal(
  input: ImportInput
): Promise<PerSessionJournalImportOutcome> {
  let inFlight = importsInFlight.get(input.database)
  if (!inFlight) {
    inFlight = new Map()
    importsInFlight.set(input.database, inFlight)
  }
  const { sessionId } = input.identity
  const run = (inFlight.get(sessionId) ?? Promise.resolve()).then(() => importOnce(input))
  const settled = run.catch(() => undefined)
  inFlight.set(sessionId, settled)
  void settled.then(() => {
    if (inFlight.get(sessionId) === settled) {
      inFlight.delete(sessionId)
    }
  })
  return run
}

async function importOnce(input: ImportInput): Promise<PerSessionJournalImportOutcome> {
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
        await copyLegacyJournal(input, source, legacy, plan)
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
  // Created but never given its schema (a crash between the two): no history, as an empty file.
  if (!source.prepare(HAS_LEGACY_TABLE).get('journal_sessions')) {
    return null
  }
  const epoch = source.prepare(SELECT_LEGACY_EPOCH).get(sessionId)?.epoch
  if (typeof epoch !== 'string' || epoch.length === 0) {
    return null
  }
  const tip = source.prepare(SELECT_LEGACY_TIP).get(sessionId, epoch)?.tip
  return { epoch, tip: typeof tip === 'number' ? tip : 0 }
}

type ImportedRow = { seq: number; ts: number; rowJson: string }
type ImportBatch = { rows: ImportedRow[]; last: boolean }

/** The file's rows, one bounded page per batch, read as each batch is written. */
function* legacyRowBatches(
  source: Database.Database,
  sessionId: string,
  epoch: string,
  batchRows: number
): Generator<ImportBatch> {
  const select = source.prepare(SELECT_LEGACY_ROWS)
  let afterSeq = Number.MIN_SAFE_INTEGER
  for (;;) {
    const rows = select
      .all(sessionId, epoch, afterSeq, batchRows)
      .map((row) => ({ seq: Number(row.seq), ts: Number(row.ts), rowJson: String(row.row_json) }))
    const lastSeq = rows.at(-1)?.seq
    const last = rows.length < batchRows || lastSeq === undefined
    yield { rows, last }
    if (last) {
      return
    }
    afterSeq = lastSeq
  }
}

function* arrayBatches(rows: readonly ImportedRow[], batchRows: number): Generator<ImportBatch> {
  for (let from = 0; ; from += batchRows) {
    const last = from + batchRows >= rows.length
    yield { rows: rows.slice(from, from + batchRows), last }
    if (last) {
      return
    }
  }
}

/**
 * Batches into a reserved block no reader follows; the last one publishes the chat's pointer, its
 * repair marker and the import marker together.
 */
async function copyLegacyJournal(
  input: ImportInput,
  source: Database.Database,
  legacy: PerSessionJournalHead,
  plan: Exclude<PerSessionImportPlan, { kind: 'copied' }>
): Promise<void> {
  const { sessionId } = input.identity
  const epoch = plan.kind === 'again' ? plan.epoch : legacy.epoch
  const repair = readLegacyRepair(source, sessionId)
  const batchRows = input.batchRows ?? IMPORT_BATCH_ROWS
  // A second copy is read whole: it is rewritten under a fresh epoch or gains a disclosure row.
  const batches =
    plan.kind === 'again'
      ? arrayBatches(
          reimportedJournalRows({
            sessionId,
            legacyEpoch: legacy.epoch,
            epoch,
            rows: [...legacyRowBatches(source, sessionId, legacy.epoch, batchRows)].flatMap(
              (batch) => batch.rows
            ),
            now: (input.now ?? Date.now)()
          }),
          batchRows
        )
      : legacyRowBatches(source, sessionId, legacy.epoch, batchRows)
  let block: number | null = null
  for (const batch of batches) {
    if (block !== null) {
      await yieldToEventLoop()
    }
    block = input.database.transaction((db) => {
      const target = block ?? reserveImportBlock(db, sessionId)
      const insert = db.prepare(INSERT_ROW)
      for (const row of batch.rows) {
        // Copied as stored: the bytes are the row, its epoch and sequence included.
        insert.run(journalRowId(target, row.seq), row.ts, row.rowJson)
      }
      if (batch.last) {
        const retired = readJournalSessionPointer(db, sessionId)
        if (retired) {
          deleteJournalBlock(db, retired.block)
        }
        publishJournalSessionEpoch(db, input.identity, { epoch, block: target })
        db.prepare(RELEASE_IMPORT_BLOCK).run(sessionId)
        if (repair) {
          db.prepare(UPSERT_REPAIR).run(
            sessionId,
            repair.epoch === legacy.epoch ? epoch : repair.epoch,
            repair.content_from,
            repair.repaired_at
          )
        }
        writePerSessionImportMarker(db, sessionId, legacy)
      }
      return target
    })
  }
  if (plan.kind === 'again') {
    // The block this copy replaced.
    void input.database.reclaimFreePages()
  }
}

/** The block this chat's copy goes into. One an earlier try left behind is emptied and reused. */
function reserveImportBlock(db: Database.Database, sessionId: string): number {
  const staged = db.prepare(SELECT_IMPORT_BLOCK).get(sessionId)?.block
  if (typeof staged === 'number') {
    deleteJournalBlock(db, staged)
    return staged
  }
  const block = allocateJournalBlock(db)
  db.prepare(RESERVE_IMPORT_BLOCK).run(sessionId, block)
  return block
}

/** The per-chat repair marker, as stored; v1 files predate the table. */
function readLegacyRepair(source: Database.Database, sessionId: string): SqliteRow | null {
  if (!source.prepare(HAS_LEGACY_TABLE).get('journal_repairs')) {
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
