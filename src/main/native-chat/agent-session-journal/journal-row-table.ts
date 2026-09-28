// Every statement the journal issues against `journal_rows` / `journal_sessions`.
//
// A chat's live epoch owns one block of row ids, `[block * 2^32, (block + 1) * 2^32)`, and a row's
// id is `block * 2^32 + seq`. So one chat's rows sit together on their own leaf pages, a replay is
// one range scan, and replacing a chat's history deletes one contiguous range. Measured on the
// largest real chat beside 19 others: 39 ms and 7.5 MB of WAL, against 214 ms and 102 MB for a
// `(session_id, epoch, seq)` key. Ids are computed in Number arithmetic, never bitwise: blocks
// stay below 2^21, so every id stays below 2^53. Columns are always named.

import type Database from '../../sqlite/sync-database'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'

export type JournalStoredRow = { epoch: string; seq: number; ts: number; rowJson: string }

/** Where a chat's live epoch is stored: its UUID, and the block its rows are keyed under. */
export type JournalBlockPointer = { epoch: string; block: number }

const BLOCK_SPAN = 2 ** 32
/** Refused at and above: `(2^21) * 2^32` is 2^53, the first id Number cannot hold exactly. */
export const JOURNAL_BLOCK_LIMIT = 2 ** 21
export const JOURNAL_SEQUENCE_LIMIT = BLOCK_SPAN

const SELECT_POINTER = 'SELECT epoch, block FROM journal_sessions WHERE session_id = ?'
const SELECT_NEXT_BLOCK = 'SELECT coalesce(max(block), -1) + 1 AS next FROM journal_sessions'
// A new epoch invalidates the saved status, which was computed at a position of the old one.
const PUBLISH_SESSION_EPOCH = `INSERT INTO journal_sessions (session_id, workspace_id, epoch, block)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  workspace_id = excluded.workspace_id, epoch = excluded.epoch, block = excluded.block,
  status_json = NULL, status_seq = NULL`
const INSERT_ROW = 'INSERT INTO journal_rows (id, ts, row_json) VALUES (?, ?, ?)'
const SELECT_ROWS_AFTER = `SELECT id, ts, row_json FROM journal_rows
WHERE id > ? AND id < ? ORDER BY id ASC`
const SELECT_ROWS_AFTER_LIMITED = `${SELECT_ROWS_AFTER} LIMIT ?`
const DELETE_RANGE = 'DELETE FROM journal_rows WHERE id >= ? AND id < ?'
const SELECT_TIP = 'SELECT max(id) AS tip FROM journal_rows WHERE id >= ? AND id < ?'

export class JournalKeySpaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalKeySpaceError'
  }
}

export function journalRowId(block: number, seq: number): number {
  if (!Number.isInteger(seq) || seq < 1 || seq >= JOURNAL_SEQUENCE_LIMIT) {
    throw new JournalKeySpaceError(`sequence ${seq} is outside a journal block`)
  }
  return block * BLOCK_SPAN + seq
}

function blockStart(block: number): number {
  return block * BLOCK_SPAN
}

export function readJournalSessionPointer(
  db: Database.Database,
  sessionId: string
): JournalBlockPointer | null {
  const row = db.prepare(SELECT_POINTER).get(sessionId)
  return typeof row?.epoch === 'string' && typeof row.block === 'number'
    ? { epoch: row.epoch, block: row.block }
    : null
}

export function readJournalSessionEpoch(db: Database.Database, sessionId: string): string | null {
  return readJournalSessionPointer(db, sessionId)?.epoch ?? null
}

/** A block no chat's live epoch holds. Inside the transaction that publishes it. */
export function allocateJournalBlock(db: Database.Database): number {
  const next = db.prepare(SELECT_NEXT_BLOCK).get()?.next
  const block = typeof next === 'number' ? next : 0
  if (block >= JOURNAL_BLOCK_LIMIT) {
    throw new JournalKeySpaceError('the chat journal has no block left to allocate')
  }
  return block
}

/** Points the chat at `epoch` in `block`. Only an epoch change writes this row. */
export function publishJournalSessionEpoch(
  db: Database.Database,
  identity: { sessionId: string; workspaceId: string },
  pointer: JournalBlockPointer
): void {
  db.prepare(PUBLISH_SESSION_EPOCH).run(
    identity.sessionId,
    identity.workspaceId,
    pointer.epoch,
    pointer.block
  )
}

export function insertJournalRow(db: Database.Database, block: number, row: JournalRow): number {
  const rowJson = serializeJournalRow(row)
  db.prepare(INSERT_ROW).run(journalRowId(block, row.seq), row.ts, rowJson)
  return Buffer.byteLength(rowJson, 'utf8')
}

/** The block's highest sequence, or 0 when it holds no row. */
export function readJournalTip(db: Database.Database, block: number): number {
  const tip = db.prepare(SELECT_TIP).get(blockStart(block), blockStart(block + 1))?.tip
  return typeof tip === 'number' ? tip - blockStart(block) : 0
}

// Why pages, not `.iterate()`: a lazily consumed cursor pins a read snapshot for as long as the
// consumer reduces, and a WAL checkpoint cannot pass an open snapshot. Each page is one completed
// statement, so the consumer's memory is bounded by a page while no snapshot outlives a fetch.
const EPOCH_ROW_PAGE_SIZE = 128

/** The live epoch's rows in sequence order, fetched one completed statement at a time. */
export function* iterateJournalEpochRows(
  db: Database.Database,
  pointer: JournalBlockPointer
): Generator<JournalStoredRow> {
  let afterSeq = 0
  for (;;) {
    const page = readJournalRowsAfter(db, pointer, afterSeq, EPOCH_ROW_PAGE_SIZE)
    yield* page
    const last = page.at(-1)
    if (page.length < EPOCH_ROW_PAGE_SIZE || last === undefined) {
      return
    }
    afterSeq = last.seq
  }
}

export function readJournalRowsAfter(
  db: Database.Database,
  pointer: JournalBlockPointer,
  afterSeq: number,
  limit?: number
): JournalStoredRow[] {
  const from = blockStart(pointer.block) + Math.max(afterSeq, 0)
  const to = blockStart(pointer.block + 1)
  const rows =
    limit !== undefined
      ? db.prepare(SELECT_ROWS_AFTER_LIMITED).all(from, to, limit)
      : db.prepare(SELECT_ROWS_AFTER).all(from, to)
  return rows.flatMap((row) =>
    typeof row.id === 'number' && typeof row.ts === 'number' && typeof row.row_json === 'string'
      ? [
          {
            epoch: pointer.epoch,
            seq: row.id - blockStart(pointer.block),
            ts: row.ts,
            rowJson: row.row_json
          }
        ]
      : []
  )
}

/** Every row of a retired block, in the transaction that retires it. */
export function deleteJournalBlock(db: Database.Database, block: number): void {
  db.prepare(DELETE_RANGE).run(blockStart(block), blockStart(block + 1))
}

/** Drop the rejected suffix a repair found, from `fromSeq` to the tip. */
export function deleteJournalRowSuffix(
  db: Database.Database,
  block: number,
  fromSeq: number
): number {
  const deleted = db
    .prepare(DELETE_RANGE)
    .run(journalRowId(block, Math.max(fromSeq, 1)), blockStart(block + 1))
  return Number(deleted.changes ?? 0)
}
