// A newer build's row of a kind this build does not know. Its envelope places it, so it holds its
// sequence and is kept on disk; nothing here reads what it says.

import type { JournalRow, JournalRowParse } from './journal-row-schema'

/** Where a skipped row sits: its place in the sequence and nothing to fold. In memory only; the
 *  stored row stays as its writer wrote it. */
export type JournalSkippedRow = {
  kind: 'skipped'
  /** The kind the row was stored under. */
  storedKind: string
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

/** A row of an unknown kind whose envelope passes every check a known row's must. A known kind
 *  that fails its own checks is malformed, never skipped. */
export function skippedJournalRow(
  record: Record<string, unknown>,
  knownKinds: ReadonlySet<string>
): JournalSkippedRow | null {
  const { kind } = record
  if (typeof kind !== 'string' || kind.length === 0 || knownKinds.has(kind)) {
    return null
  }
  if (!hasJournalRowEnvelope(record)) {
    return null
  }
  const { epoch, seq, fence, ts } = record
  return { kind: 'skipped', storedKind: kind, epoch, seq, fence, ts }
}

/** The fields every row carries whatever its kind: the chat's epoch, a place in it, and its writer. */
export function hasJournalRowEnvelope(
  record: Record<string, unknown>
): record is Record<string, unknown> & Omit<JournalSkippedRow, 'kind' | 'storedKind'> {
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

/** A skipped row's stored text at a new place: its envelope restamped, everything else kept as its
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
