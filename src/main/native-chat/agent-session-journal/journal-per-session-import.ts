// Copying a chat's per-chat journal file into the host's one database, on that chat's open.
//
// Not `journal-legacy-import.ts`, which reads the PROVIDER's own transcript. This reads Orca's own
// earlier `<legacyDir>/journal.db`, verbatim: the same epoch UUID and every sequence number, so a
// cursor, an `acceptedSequence` or a restart offer taken before the upgrade still points at the
// same row after it. A file that reappears after a downgrade is copied again, unless the older
// build started it from nothing; that one is left on disk (see journal-per-session-reimport.ts).
//
// The copy runs in bounded batches, each its own transaction, yielding the event loop between them.
// The rows go into a block `journal_import_blocks` reserves, which no reader follows. Once the
// copied block reads back as the file does (epoch, tip, rows, items, submissions), one transaction
// publishes the chat's pointer with its repair and import markers, so the chat is imported all at
// once or not at all. A try that stops midway leaves only that reserved block, which the next try
// clears and copies again. A copy that does not read back as the file is never published: the
// file stays, and the chat is refused as unreadable.
//
// Only after that commit is the file deleted, its connection closed first. A read that fails
// leaves the file where it is for the next open, and the open is refused rather than served empty:
// an empty chat founded here would take a new epoch the next open's import could not reconcile.

import { existsSync } from 'node:fs'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { JournalImportMismatchError, journalOpenRefusalError } from './journal-open-failure'
import { legacyJournalDatabaseFile } from './journal-paths'
import {
  planPerSessionImport,
  readPerSessionImportMarker,
  reimportedJournalRows,
  writePerSessionImportMarker,
  type PerSessionImportPlan
} from './journal-per-session-reimport'
import {
  foldLegacyJournal,
  IMPORT_BATCH_ROWS,
  legacyRowBatches,
  openLegacySource,
  readLegacyHead,
  readLegacyRepair,
  removeLegacyJournal,
  type ImportBatch,
  type LegacyJournalHead,
  type ImportedRow
} from './journal-per-session-source'
import { parseJournalRow } from './journal-row-schema'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  allocateJournalBlock,
  deleteJournalBlock,
  journalRowId,
  publishJournalSessionEpoch,
  readJournalRowsAfter,
  readJournalSessionPointer
} from './journal-row-table'

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
  /** Deletes one of the per-chat files. */
  remove?: (path: string) => void
  now?: () => number
  batchRows?: number
}

export type PerSessionJournalImportOutcome = 'absent' | 'imported' | 'already-imported' | 'kept'

type ImportInput = {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  legacyDirectory: string
} & PerSessionJournalImportDeps

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
  let legacy: LegacyJournalHead | null
  let plan: PerSessionImportPlan | null = null
  try {
    legacy = readLegacyHead(source, sessionId)
    if (legacy) {
      plan = planPerSessionImport({ db: input.database.db, sessionId, legacy, current })
      if (plan.kind === 'first' || plan.kind === 'again') {
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
    retireLegacyJournal(input)
    return 'already-imported'
  }
  if (plan?.kind === 'kept') {
    return 'kept'
  }
  // Also a file a crash left after its copy was recorded (`copied`): deleted now, not copied again.
  retireLegacyJournal(input)
  if (plan?.kind === 'copied') {
    return 'already-imported'
  }
  // The open's replay of what was just copied is a long task of its own; don't add this one to it.
  await yieldToEventLoop()
  return 'imported'
}

/**
 * The chat a first copy would import, folded straight from its per-chat file and copying nothing:
 * for a restore, which must not import. Null when the open has to import now instead: the chat is
 * already in the host's database or was copied before (the reimport rules decide), its file holds
 * no chat, or its fold needs a repair written. The file is closed before this returns.
 */
export async function previewPerSessionJournal(
  input: Pick<ImportInput, 'database' | 'identity' | 'legacyDirectory' | 'openSource'>
): Promise<JournalLoad | null> {
  const { sessionId } = input.identity
  const db = input.database.db
  const sourcePath = legacyJournalDatabaseFile(input.legacyDirectory)
  if (
    readJournalSessionPointer(db, sessionId) ||
    readPerSessionImportMarker(db, sessionId) ||
    !existsSync(sourcePath)
  ) {
    return null
  }
  const source = (input.openSource ?? openLegacySource)(sourcePath)
  try {
    const legacy = readLegacyHead(source, sessionId)
    if (!legacy) {
      return null
    }
    const loaded = await foldLegacyJournal(source, sessionId, legacy)
    return loaded.corrupt || loaded.readOnly || loaded.truncateFrom !== undefined ? null : loaded
  } finally {
    source.close()
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
 * Batches into a reserved block no reader follows. Once the block reads back as the file does, one
 * transaction publishes the chat's pointer with its repair marker and the import marker.
 */
async function copyLegacyJournal(
  input: ImportInput,
  source: Database.Database,
  legacy: LegacyJournalHead,
  plan: Extract<PerSessionImportPlan, { kind: 'first' | 'again' }>
): Promise<void> {
  const { sessionId } = input.identity
  const epoch = plan.kind === 'again' ? plan.epoch : legacy.epoch
  const repair = readLegacyRepair(source, sessionId)
  const batchRows = input.batchRows ?? IMPORT_BATCH_ROWS
  // A second copy is read whole: it is rewritten under a fresh epoch or gains a disclosure row.
  const rewritten =
    plan.kind === 'again'
      ? reimportedJournalRows({
          sessionId,
          legacyEpoch: legacy.epoch,
          epoch,
          rows: [...legacyRowBatches(source, sessionId, legacy.epoch, batchRows)].flatMap(
            (batch) => batch.rows
          ),
          now: (input.now ?? Date.now)()
        })
      : null
  const batches = rewritten
    ? arrayBatches(rewritten, batchRows)
    : legacyRowBatches(source, sessionId, legacy.epoch, batchRows)
  let block: number | null = null
  for (const batch of batches) {
    if (block !== null) {
      await yieldToEventLoop()
    }
    // Unsynced: no reader follows the reserved block, and the publish's synced commit covers it.
    block = input.database.unsyncedTransaction((db) => {
      const target = block ?? reserveImportBlock(db, sessionId)
      const insert = db.prepare(INSERT_ROW)
      for (const row of batch.rows) {
        // Copied as stored: the bytes are the row, its epoch and sequence included.
        insert.run(journalRowId(target, row.seq), row.ts, row.rowJson)
      }
      return target
    })
  }
  const target = block ?? input.database.transaction((db) => reserveImportBlock(db, sessionId))
  await verifyCopiedJournal(
    input,
    rewritten
      ? arrayBatches(rewritten, batchRows)
      : legacyRowBatches(source, sessionId, legacy.epoch, batchRows),
    { epoch, block: target }
  )
  input.database.transaction((db) => {
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
  })
  if (plan.kind === 'again') {
    // The block this copy replaced.
    void input.database.reclaimFreePages()
  }
}

/** Mismatches already logged, so a chat refused on every open logs once. */
const loggedMismatches = new Set<string>()

/**
 * The copied block, read back from the host's database, against a second read of what was copied:
 * the same epoch, tip, row count, items and submissions, or the copy is refused and never
 * published. Both reads go a batch at a time, so no check holds the main thread longer than a copy
 * batch does.
 */
async function verifyCopiedJournal(
  input: ImportInput,
  expected: Iterable<ImportBatch>,
  copied: { epoch: string; block: number }
): Promise<void> {
  const { sessionId } = input.identity
  const want = await copyFacts(sessionId, expected)
  const got = await copyFacts(sessionId, copiedBatches(input, copied))
  if (want === got) {
    return
  }
  const error = new JournalImportMismatchError(
    `per-chat journal of ${sessionId} read back as ${got} after its copy, not ${want}`
  )
  if (!loggedMismatches.has(`${sessionId}\n${want}\n${got}`)) {
    loggedMismatches.add(`${sessionId}\n${want}\n${got}`)
    console.error(`[agent-session-journal] ${error.message}; ${input.legacyDirectory} is kept`)
  }
  throw journalOpenRefusalError(error)
}

/** Epoch, tip, row count, items and submissions, folded a batch at a time. */
async function copyFacts(sessionId: string, batches: Iterable<ImportBatch>): Promise<string> {
  const state = createJournalReducerState(sessionId, '')
  let epoch: string | null = null
  let tip = 0
  let rows = 0
  let first = true
  for (const batch of batches) {
    if (!first) {
      await yieldToEventLoop()
    }
    first = false
    rows += batch.rows.length
    for (const row of batch.rows) {
      tip = Math.max(tip, row.seq)
      const parsed = parseJournalRow(row.rowJson)
      if (parsed.ok) {
        epoch ??= parsed.row.epoch
        applyJournalRow(state, parsed.row)
      }
    }
  }
  return `${epoch}:${tip}:${rows}:${state.items.size}:${state.submissions.size}`
}

function* copiedBatches(
  input: ImportInput,
  copied: { epoch: string; block: number }
): Generator<ImportBatch> {
  const batchRows = input.batchRows ?? IMPORT_BATCH_ROWS
  let afterSeq = 0
  for (;;) {
    const rows = readJournalRowsAfter(input.database.db, copied, afterSeq, batchRows)
    const lastSeq = rows.at(-1)?.seq
    const last = rows.length < batchRows || lastSeq === undefined
    yield { rows, last }
    if (last) {
      return
    }
    afterSeq = lastSeq
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

/** Best effort: the copy is committed, so a file left behind is deleted by the next open. */
function retireLegacyJournal(input: ImportInput): void {
  try {
    removeLegacyJournal(input.legacyDirectory, input.remove)
  } catch (error) {
    console.warn(`[agent-session-journal] deleting imported ${input.legacyDirectory} failed`, error)
  }
}
