// The host journal database for a test's state directory, opened the one way production opens it:
// under a held owner lock. One per directory per test process, as one per state directory per
// host process in production, so a test that "restarts" a host on the same directory reads the
// same database the way a restarted host would.

import { resolve } from 'node:path'
import { JournalHostDatabase } from './journal-host-database'
import { replayJournal, type JournalLoad } from './journal-open'
import type { JournalRow } from './journal-row-schema'
import {
  allocateJournalBlock,
  insertJournalRow,
  iterateJournalEpochRows,
  journalRowId,
  publishJournalSessionEpoch,
  readJournalSessionPointer,
  type JournalBlockPointer,
  type JournalStoredRow
} from './journal-row-table'
import type Database from '../../sqlite/sync-database'
import { tryAcquireJournalOwnerLock, type JournalOwnerLock } from './journal-owner-lock'
import type { AgentSessionJournal } from './journal-store'
import type { AgentSessionJournalOptions } from './journal-store-contracts'
import { openAgentSessionJournal } from './journal-store-factory'

const opened = new Map<string, { lock: JournalOwnerLock; database: JournalHostDatabase }>()

export function openTestJournalHostDatabase(stateDirectory: string): JournalHostDatabase {
  const directory = resolve(stateDirectory)
  const existing = opened.get(directory)
  if (existing && !existing.database.isClosed) {
    return existing.database
  }
  const lock = existing?.lock.isHeld ? existing.lock : tryAcquireJournalOwnerLock(directory)
  if (!lock) {
    throw new Error(`another process owns the chat journal in ${directory}`)
  }
  const database = JournalHostDatabase.open(lock)
  opened.set(directory, { lock, database })
  return database
}

/** Closes every database this process opened for tests, then releases their locks. */
export function closeTestJournalHostDatabases(): void {
  for (const { lock, database } of opened.values()) {
    database.close()
    lock.release()
  }
  opened.clear()
}

export type TestJournalOptions = Omit<AgentSessionJournalOptions, 'database'> & {
  /** The state directory whose one journal database holds this chat. */
  stateDirectory: string
}

export type TrackedJournalOpener = {
  open: (options: TestJournalOptions) => Promise<AgentSessionJournal>
  track: <T extends AgentSessionJournal>(journal: T) => T
  /** Drains every tracked journal, then closes the databases and releases their locks. */
  closeAll: () => Promise<void>
}

export function createTrackedJournalOpener(): TrackedJournalOpener {
  const journals: AgentSessionJournal[] = []
  return {
    open: async ({ stateDirectory, ...options }) => {
      const journal = await openAgentSessionJournal({
        ...options,
        database: openTestJournalHostDatabase(stateDirectory)
      })
      journals.push(journal)
      return journal
    },
    track: (journal) => {
      journals.push(journal)
      return journal
    },
    closeAll: async () => {
      await Promise.allSettled(journals.splice(0).map((journal) => journal.close()))
      closeTestJournalHostDatabases()
    }
  }
}

/** What a fresh open of the chat would replay, read from the test state directory's database. */
export function loadTestJournal(stateDirectory: string, sessionId: string): JournalLoad | null {
  return replayJournal(openTestJournalHostDatabase(stateDirectory).db, sessionId)
}

// Staging on-disk states for a case, addressed the way the case thinks of them: by chat and sequence.

function livePointer(db: Database.Database, sessionId: string): JournalBlockPointer {
  const pointer = readJournalSessionPointer(db, sessionId)
  if (!pointer) {
    throw new Error(`no journal for ${sessionId}`)
  }
  return pointer
}

/** Points the chat at a new epoch in a fresh block, as a publish would. */
export function publishTestJournalEpoch(
  db: Database.Database,
  sessionId: string,
  epoch: string
): void {
  publishJournalSessionEpoch(
    db,
    { sessionId, workspaceId: 'ws-1' },
    { epoch, block: allocateJournalBlock(db) }
  )
}

/** The chat's rows of `epoch` — none once that epoch is no longer the live one. */
export function readTestJournalRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalStoredRow[] {
  const pointer = readJournalSessionPointer(db, sessionId)
  return pointer?.epoch === epoch ? [...iterateJournalEpochRows(db, pointer)] : []
}

/** The chat's rows of whichever epoch is live now. */
export function liveTestJournalRows(db: Database.Database, sessionId: string): JournalStoredRow[] {
  const pointer = readJournalSessionPointer(db, sessionId)
  return pointer ? [...iterateJournalEpochRows(db, pointer)] : []
}

export function insertTestJournalRow(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): void {
  insertJournalRow(db, livePointer(db, sessionId).block, row)
}

/** A raw `row_json` at `seq`, the way a newer build or a bad write would leave it. */
export function insertTestJournalRowJson(
  db: Database.Database,
  sessionId: string,
  seq: number,
  rowJson: string
): void {
  db.prepare('INSERT INTO journal_rows (id, ts, row_json) VALUES (?, ?, ?)').run(
    journalRowId(livePointer(db, sessionId).block, seq),
    1,
    rowJson
  )
}

export function updateTestJournalRowJson(
  db: Database.Database,
  sessionId: string,
  seq: number,
  rowJson: string
): void {
  db.prepare('UPDATE journal_rows SET row_json = ? WHERE id = ?').run(
    rowJson,
    journalRowId(livePointer(db, sessionId).block, seq)
  )
}

export function deleteTestJournalRow(db: Database.Database, sessionId: string, seq: number): void {
  db.prepare('DELETE FROM journal_rows WHERE id = ?').run(
    journalRowId(livePointer(db, sessionId).block, seq)
  )
}
