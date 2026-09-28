// Loading a journal: the session projection names the live epoch, and that
// epoch's rows are folded through the reducer in sequence order.
//
// There is no snapshot to anchor to and no superseded-epoch rows to drop — a
// roll deletes them in the same transaction that publishes the new epoch. A gap
// in the surviving sequence is corruption, and the caller rolls the epoch
// rather than rendering a partial timeline.

import type Database from '../../sqlite/sync-database'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import {
  iterateJournalEpochRows,
  readJournalRowsAfter,
  readJournalSessionPointer,
  type JournalBlockPointer
} from './journal-row-table'
import { JOURNAL_REPAIR_DISCLOSURE_ITEM_ID } from './journal-repair-disclosure'
import { pendingJournalRepairSequence } from './journal-repair-marker'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

/** Every epoch row is sequence 1, and no compaction moves that floor. */
const FIRST_JOURNAL_SEQUENCE = 1

export type JournalLoad = {
  state: JournalReducerState
  /** The block the live epoch's rows are keyed under. */
  block: number
  /** A row from a future schema was met: no writes, no deletion. */
  readOnly: boolean
  /** Set when the surviving prefix is unusable and the caller must roll the epoch. */
  corrupt: boolean
  /** Rows skipped because their body failed to parse (future-version rows are
   *  `readOnly`, never counted here). The store discloses these in the timeline. */
  malformedRows: number
  /** Directory-internal: the first sequence of an unusable suffix. The store
   *  deletes from here before it accepts a write; a probe leaves it alone. */
  truncateFrom?: number
}

/** Replays one chat from the host's database. Returns null when the chat has no journal yet. */
export function replayJournal(db: Database.Database, sessionId: string): JournalLoad | null {
  const pointer = readJournalSessionPointer(db, sessionId)
  if (!pointer) {
    return null
  }
  const { epoch } = pointer
  const state = createJournalReducerState(sessionId, epoch)
  const repairedFrom = pendingJournalRepairSequence(db, sessionId, epoch)
  let expectedSequence = FIRST_JOURNAL_SEQUENCE
  let gapSequence: number | undefined
  let unanchoredSequence: number | undefined
  let anchor: Extract<JournalRow, { kind: 'epoch' }> | undefined
  let repairHasContent = false
  let providerHasContent = false
  let malformedRows = 0
  let latched = false
  let truncateFrom: number | undefined

  for (const entry of iterateJournalEpochRows(db, pointer)) {
    const parsed = parseJournalRow(entry.rowJson)
    if (!parsed.ok) {
      truncateFrom = entry.seq
      latched = parsed.unreadable
      malformedRows = parsed.unreadable ? 0 : 1
      break
    }
    const row = parsed.row
    // Parse past a gap so an unreadable future row still latches read-only.
    if (gapSequence !== undefined) {
      continue
    }
    if (row.seq !== expectedSequence) {
      gapSequence = row.seq
      continue
    }
    expectedSequence += 1
    if (row.seq === FIRST_JOURNAL_SEQUENCE) {
      if (row.kind === 'epoch') {
        anchor = row
      } else {
        unanchoredSequence = row.seq
      }
    }
    if (!anchor) {
      continue
    }
    applyJournalRow(state, row)
    const disclosure = row.kind === 'item' && row.itemId === JOURNAL_REPAIR_DISCLOSURE_ITEM_ID
    if (!disclosure) {
      repairHasContent ||= repairedFrom !== null && row.seq >= repairedFrom
      providerHasContent ||= row.seq >= FIRST_JOURNAL_SEQUENCE + 1
    }
  }
  // Anchor rejection takes precedence over a gap, which takes precedence over malformed rows.
  truncateFrom = unanchoredSequence ?? gapSequence ?? truncateFrom
  state.oldestSequence = FIRST_JOURNAL_SEQUENCE
  return {
    state,
    block: pointer.block,
    readOnly: latched,
    corrupt:
      gapSequence !== undefined ||
      malformedRows > 0 ||
      (!latched && !anchor) ||
      (repairedFrom !== null && !repairHasContent) ||
      (anchor?.reason === 'unreconcilable_prefix' && !providerHasContent),
    malformedRows,
    ...(truncateFrom !== undefined && !latched ? { truncateFrom } : {})
  }
}

/** Rows after a cursor, in sequence order. Stops at the first row this build
 *  cannot parse, exactly as replay does. */
export function readJournalRowsAfterCursor(
  db: Database.Database,
  pointer: JournalBlockPointer,
  afterSequence: number,
  limit?: number
): JournalRow[] {
  const rows: JournalRow[] = []
  for (const stored of readJournalRowsAfter(db, pointer, afterSequence, limit)) {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      break
    }
    rows.push(parsed.row)
  }
  return rows
}
