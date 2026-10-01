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
import { IMPORT_BATCH_ROWS } from './journal-per-session-source'
import { pendingJournalRepairSequence } from './journal-repair-marker'
import { readJournalRowsAfter, readJournalSessionEpoch, readJournalTip } from './journal-row-table'
import {
  deriveJournalSessionStatus,
  hasJournalSessionStatus,
  writeJournalSessionStatus,
  type JournalSessionStatus
} from './journal-session-state'

const SELECT_WITHOUT_STATUS = `SELECT s.session_id AS session_id FROM journal_sessions s
WHERE NOT EXISTS (SELECT 1 FROM journal_session_state st WHERE st.session_id = s.session_id)`

/** Every chat in the host's database with no status row. */
export function readJournalSessionIdsWithoutStatus(db: Database.Database): string[] {
  return db
    .prepare(SELECT_WITHOUT_STATUS)
    .all()
    .flatMap((row) => (typeof row.session_id === 'string' ? [row.session_id] : []))
}

export function hasJournalSessionWithoutStatus(db: Database.Database): boolean {
  return db.prepare(`${SELECT_WITHOUT_STATUS} LIMIT 1`).get() !== undefined
}

/** The chat's row: its rows folded a batch per task, as a replay folds them, then the row derived
 *  and written in one short transaction, only while the chat is still where the fold read it. Null
 *  when something wrote the row or the chat first, the chat has no journal, or quit stopped it. */
export async function backfillJournalSessionStatus(
  database: JournalHostDatabase,
  sessionId: string,
  batchRows = IMPORT_BATCH_ROWS
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
    if (!rows.every(fold.add) || rows.length < batchRows || !last) {
      break
    }
    afterSeq = last.seq
    // A batch per task: a long chat's whole replay in one task holds up every other chat.
    await yieldToEventLoop()
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
