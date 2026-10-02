// Writing the status row a chat already in the host's database is missing.
//
// Version 5 creates the status table empty, so after an upgrade every chat has no row until
// something writes it. Startup selects the chats to settle from rows, so one a crash left mid-turn
// and that nobody opens would never be settled. The background copy fills these in, a chat at a
// time, inside that chat's serialize: the chat folded a batch per task, then only the derive and
// the write in one short transaction, as a per-chat file's copy writes its row from its own fold.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import { startJournalRowFold, type JournalLoad } from './journal-open'
import {
  charBoundedBatches,
  IMPORT_BATCH_CHARS,
  IMPORT_BATCH_ROWS
} from './journal-per-session-source'
import { pendingJournalRepairSequence } from './journal-repair-marker'
import { readJournalRowsAfter, readJournalSessionEpoch, readJournalTip } from './journal-row-table'
import {
  deriveJournalSessionStatus,
  hasJournalSessionStatus,
  writeJournalSessionStatus,
  type JournalSessionStatus
} from './journal-session-state'

// The give-up's input is built here as `journalStatusInput` builds it.
const SELECT_WITHOUT_STATUS = `SELECT s.session_id AS session_id FROM journal_sessions s
WHERE NOT EXISTS (SELECT 1 FROM journal_session_state st WHERE st.session_id = s.session_id)
AND NOT EXISTS (SELECT 1 FROM journal_background_failures f
  WHERE f.session_id = s.session_id AND f.step = 'status' AND f.app_version = ?
  AND f.input = s.epoch || ':' || (SELECT ifnull(max(r.seq), 0) FROM journal_rows r
    WHERE r.session_id = s.session_id AND r.epoch = s.epoch))`

/** Every chat in the host's database with no status row, but one whose row failed for good on
 *  the rows it holds now, under this app version (journal-background-failures.ts). */
export function readJournalSessionIdsWithoutStatus(
  db: Database.Database,
  appVersion: string
): string[] {
  return db
    .prepare(SELECT_WITHOUT_STATUS)
    .all(appVersion)
    .flatMap((row) => (typeof row.session_id === 'string' ? [row.session_id] : []))
}

/** What a give-up of the chat's status row is keyed to: its epoch and tip. */
export function journalStatusInput(db: Database.Database, sessionId: string): string | null {
  const epoch = readJournalSessionEpoch(db, sessionId)
  return epoch === null ? null : `${epoch}:${readJournalTip(db, sessionId, epoch)}`
}

/** The chat's row: its rows folded a batch per task, as a replay folds them, then the row derived
 *  and written in one short transaction, only while the chat is still where the fold read it. Null
 *  when something wrote the row or the chat first, the chat has no journal, or quit stopped it. */
export async function backfillJournalSessionStatus(
  database: JournalHostDatabase,
  sessionId: string,
  {
    batchRows = IMPORT_BATCH_ROWS,
    batchChars = IMPORT_BATCH_CHARS,
    yieldTask = () => yieldToEventLoop()
  }: {
    batchRows?: number
    batchChars?: number
    /** Ends each batch's task: the next macrotask by default; the background copy paces here. */
    yieldTask?: () => Promise<void>
  } = {}
): Promise<{ load: JournalLoad; status: JournalSessionStatus } | null> {
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
    if (database.importsAborted) {
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
    }
    if (!folding || rows.length < batchRows || !last) {
      break
    }
    afterSeq = last.seq
    await yieldTask()
  }
  const load = fold.finish()
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
