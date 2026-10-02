// Writing the status row a chat already in the host's database is missing, without opening it.
//
// Version 5 creates the status table empty, so after an upgrade every chat has no row until
// something writes it. Rather than open each chat (its lease, settle and conversation), its rows are
// folded a bounded part per task, as a replay folds them, then the row is derived and written in one
// short transaction, only while the chat is still where the fold read it. The startup pass and the
// background copy both write missing rows through this one function.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { JournalHostDatabase } from './journal-host-database'
import { startJournalRowFold, type JournalLoad } from './journal-open'
import { IMPORT_BATCH_ROWS } from './journal-per-session-source'
import { pendingJournalRepairSequence } from './journal-repair-marker'
import { readJournalRowsAfter, readJournalSessionEpoch, readJournalTip } from './journal-row-table'
import {
  deriveJournalSessionStatus,
  hasJournalSessionStatus,
  writeJournalSessionStatus,
  type JournalSessionStatus
} from './journal-session-state'

/** Row JSON per part, in UTF-16 units: a page of large rows is split, so each main-thread task
 *  handles about the same bytes (a quarter of a full page of the seed's 2.3 KB rows). */
export const IMPORT_BATCH_CHARS = 256 * 1024

/** Each batch split so no part holds more than `maxChars` of row JSON; a larger row is a part alone.
 *  Only a batch's last part keeps its `last`. */
export function* charBoundedBatches<Row extends { rowJson: string }>(
  batches: Iterable<{ rows: Row[]; last: boolean }>,
  maxChars = IMPORT_BATCH_CHARS
): Generator<{ rows: Row[]; last: boolean }> {
  for (const batch of batches) {
    let part: Row[] = []
    let chars = 0
    for (const row of batch.rows) {
      if (part.length > 0 && chars + row.rowJson.length > maxChars) {
        yield { rows: part, last: false }
        part = []
        chars = 0
      }
      part.push(row)
      chars += row.rowJson.length
    }
    yield { rows: part, last: batch.last }
  }
}

/** The chat's row: its rows folded a part per task, as a replay folds them, then the row derived
 *  and written in one short transaction, only while the chat is still where the fold read it. Null
 *  when something wrote the row or the chat first, the chat has no epoch in this database (it is
 *  still in a per-chat file), the database or the chat's rows are a newer build's, or `signal`
 *  aborted, which is checked before each part. */
export async function backfillJournalSessionStatus(
  database: JournalHostDatabase,
  sessionId: string,
  {
    batchRows = IMPORT_BATCH_ROWS,
    batchChars = IMPORT_BATCH_CHARS,
    yieldTask = () => yieldToEventLoop(),
    signal
  }: {
    batchRows?: number
    batchChars?: number
    /** Ends each part's task: the next macrotask by default; a background job paces here. */
    yieldTask?: () => Promise<void>
    /** Quit: the fold stops within one part and nothing is written. */
    signal?: AbortSignal
  } = {}
): Promise<{ load: JournalLoad; status: JournalSessionStatus } | null> {
  if (database.readOnly) {
    return null
  }
  const epoch = readJournalSessionEpoch(database.db, sessionId)
  if (epoch === null || hasJournalSessionStatus(database.db, sessionId)) {
    return null
  }
  const tip = readJournalTip(database.db, sessionId, epoch)
  const fold = startJournalRowFold({
    sessionId,
    epoch,
    repairedFrom: pendingJournalRepairSequence(database.db, sessionId, epoch)
  })
  for (let afterSeq = Number.MIN_SAFE_INTEGER; ;) {
    if (signal?.aborted) {
      return null
    }
    const rows = readJournalRowsAfter(database.db, sessionId, epoch, afterSeq, batchRows)
    const last = rows.at(-1)
    let folding = true
    for (const part of charBoundedBatches([{ rows, last: true }], batchChars)) {
      folding = part.rows.every(fold.add)
      // A part per task: a long chat's whole replay in one task holds up every other chat.
      if (!folding || part.last) {
        break
      }
      await yieldTask()
      if (signal?.aborted) {
        return null
      }
    }
    if (!folding || rows.length < batchRows || !last) {
      break
    }
    afterSeq = last.seq
    await yieldTask()
  }
  if (signal?.aborted) {
    return null
  }
  const load = fold.finish()
  // A newer build's rows: as an open of it does, this build writes nothing for the chat.
  if (load.readOnly) {
    return null
  }
  return database.transaction((db) => {
    if (
      hasJournalSessionStatus(db, sessionId) ||
      readJournalSessionEpoch(db, sessionId) !== epoch ||
      readJournalTip(db, sessionId, epoch) !== tip
    ) {
      return null
    }
    const status = deriveJournalSessionStatus(load.state, { settlesRosters: !load.corrupt })
    writeJournalSessionStatus(db, sessionId, status)
    return { load, status }
  })
}
