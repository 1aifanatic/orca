// Every statement the journal issues against `journal_rows` / `journal_sessions`.
//
// Each one is a prefix or range scan of one chat's rows on the primary key. Columns are always
// named: `SELECT *` is uncacheable and can drop a column.

import type Database from '../../sqlite/sync-database'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'

export type JournalStoredRow = { epoch: string; seq: number; ts: number; rowJson: string }

const SELECT_SESSION = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
// A new epoch invalidates the saved status, which was computed at a position of the old one.
const PUBLISH_SESSION_EPOCH = `INSERT INTO journal_sessions (session_id, workspace_id, epoch)
VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  workspace_id = excluded.workspace_id, epoch = excluded.epoch,
  status_json = NULL, status_seq = NULL`
const INSERT_ROW =
  'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
const SELECT_ROWS_AFTER = `SELECT epoch, seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC`
const SELECT_ROWS_AFTER_LIMITED = `${SELECT_ROWS_AFTER} LIMIT ?`
const DELETE_SESSION_ROWS = 'DELETE FROM journal_rows WHERE session_id = ?'
const DELETE_SUFFIX = 'DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq >= ?'
const SELECT_TIP = 'SELECT max(seq) AS tip FROM journal_rows WHERE session_id = ? AND epoch = ?'

export function readJournalSessionEpoch(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare(SELECT_SESSION).get(sessionId) as { epoch?: string } | undefined
  return row?.epoch ?? null
}

/** Points the chat at `epoch`. Only an epoch change writes this row; an append never does. */
export function publishJournalSessionEpoch(
  db: Database.Database,
  identity: { sessionId: string; workspaceId: string },
  epoch: string
): void {
  db.prepare(PUBLISH_SESSION_EPOCH).run(identity.sessionId, identity.workspaceId, epoch)
}

export function insertJournalRow(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): number {
  const rowJson = serializeJournalRow(row)
  db.prepare(INSERT_ROW).run(sessionId, row.epoch, row.seq, row.ts, rowJson)
  return Buffer.byteLength(rowJson, 'utf8')
}

/** The live epoch's highest sequence, or 0 when it holds no row. */
export function readJournalTip(db: Database.Database, sessionId: string, epoch: string): number {
  const tip = db.prepare(SELECT_TIP).get(sessionId, epoch)?.tip
  return typeof tip === 'number' ? tip : 0
}

// Why pages, not `.iterate()`: a lazily consumed cursor pins a read snapshot for as long as the
// consumer reduces, and a WAL checkpoint cannot pass an open snapshot. Each page is one completed
// statement, so the consumer's memory is bounded by a page while no snapshot outlives a fetch.
const EPOCH_ROW_PAGE_SIZE = 128

/** Epoch rows in sequence order, fetched one completed statement at a time. */
export function* iterateJournalEpochRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): Generator<JournalStoredRow> {
  let afterSeq = Number.MIN_SAFE_INTEGER
  for (;;) {
    const page = readJournalRowsAfter(db, sessionId, epoch, afterSeq, EPOCH_ROW_PAGE_SIZE)
    yield* page
    const last = page.at(-1)
    if (page.length < EPOCH_ROW_PAGE_SIZE || last === undefined) {
      return
    }
    afterSeq = last.seq
  }
}

/** Every row of one epoch, in sequence order. */
export function readJournalEpochRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalStoredRow[] {
  return [...iterateJournalEpochRows(db, sessionId, epoch)]
}

export function readJournalRowsAfter(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSeq: number,
  limit?: number
): JournalStoredRow[] {
  if (limit !== undefined) {
    return toStoredRows(
      db.prepare(SELECT_ROWS_AFTER_LIMITED).all(sessionId, epoch, afterSeq, limit)
    )
  }
  return toStoredRows(db.prepare(SELECT_ROWS_AFTER).all(sessionId, epoch, afterSeq))
}

/** Every row the chat holds, whatever its epoch: a new epoch replaces them all. */
export function deleteJournalSessionRows(db: Database.Database, sessionId: string): void {
  db.prepare(DELETE_SESSION_ROWS).run(sessionId)
}

/** Drop the rejected suffix a repair found, from `fromSeq` to the tip. */
export function deleteJournalRowSuffix(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  fromSeq: number
): number {
  const deleted = db.prepare(DELETE_SUFFIX).run(sessionId, epoch, fromSeq)
  return Number(deleted.changes ?? 0)
}

function toStoredRows(rows: readonly unknown[]): JournalStoredRow[] {
  return rows.map((entry) => {
    const record = entry as { epoch: string; seq: number; ts: number; row_json: string }
    return { epoch: record.epoch, seq: record.seq, ts: record.ts, rowJson: record.row_json }
  })
}
