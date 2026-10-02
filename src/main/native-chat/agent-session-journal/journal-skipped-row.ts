// A newer build's row of a kind this build does not know, which its writer declared an older build
// may read past. Its envelope places it, so it holds its sequence and is kept on disk; nothing here
// reads what it says.

import {
  JOURNAL_ROW_IF_UNKNOWN,
  JOURNAL_ROW_KINDS,
  type JournalRowIfUnknown
} from './journal-row-kind-compatibility'
import type { JournalRow, JournalRowParse } from './journal-row-schema'

/** Where a skipped row sits: its place in the sequence and nothing to fold. In memory only; the
 *  stored row stays as its writer wrote it. */
export type JournalSkippedRow = {
  kind: 'skipped'
  /** The kind the row was stored under. */
  storedKind: string
  ifUnknown: JournalRowIfUnknown
  epoch: string
  seq: number
  fence: number
  ts: number
}

/** A row as a reader meets it: one this build folds, or a placeholder for one it skips. */
export type JournalReadRow = JournalRow | JournalSkippedRow

/** The row a reader folds or skips past; null where it must stop. */
export function journalReadRow(parsed: JournalRowParse): JournalReadRow | null {
  return parsed.ok ? parsed.row : (parsed.skipped ?? null)
}

/** A row of a kind this build does not know: skipped where its writer declared that safe,
 *  `unreadable` where it did not, and null where no envelope places it (malformed). */
export function unknownKindJournalRow(
  record: Record<string, unknown>
): JournalSkippedRow | 'unreadable' | null {
  const { kind, ifUnknown } = record
  if (typeof kind !== 'string' || kind.length === 0 || JOURNAL_ROW_KINDS.has(kind)) {
    return null
  }
  if (!hasJournalRowEnvelope(record)) {
    return null
  }
  const declared = JOURNAL_ROW_IF_UNKNOWN.find((value) => value === ifUnknown)
  if (!declared) {
    return 'unreadable'
  }
  const { epoch, seq, fence, ts } = record
  return { kind: 'skipped', storedKind: kind, ifUnknown: declared, epoch, seq, fence, ts }
}

/** The fields every row carries whatever its kind: the chat's epoch, a place in it, and its writer. */
export function hasJournalRowEnvelope(
  record: Record<string, unknown>
): record is Record<string, unknown> & Pick<JournalSkippedRow, 'epoch' | 'seq' | 'fence' | 'ts'> {
  return (
    typeof record.epoch === 'string' &&
    record.epoch.length > 0 &&
    typeof record.seq === 'number' &&
    Number.isInteger(record.seq) &&
    record.seq >= 1 &&
    typeof record.fence === 'number' &&
    Number.isInteger(record.fence) &&
    typeof record.ts === 'number'
  )
}

/** A carried row's stored text at a new place: its envelope restamped, everything else kept as its
 *  writer wrote it. */
export function restampSkippedJournalRow(
  rowJson: string,
  skipped: JournalSkippedRow,
  place: Pick<JournalSkippedRow, 'epoch' | 'seq' | 'fence'>
): { rowJson: string; row: JournalSkippedRow } | null {
  const stored: unknown = JSON.parse(rowJson)
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return null
  }
  return { rowJson: JSON.stringify({ ...stored, ...place }), row: { ...skipped, ...place } }
}
