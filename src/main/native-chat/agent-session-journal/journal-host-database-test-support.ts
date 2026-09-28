// The host journal database for a test's state directory, opened the one way production opens it:
// under a held owner lock. One per directory per test process, as one per state directory per
// host process in production, so a test that "restarts" a host on the same directory reads the
// same database the way a restarted host would.

import { resolve } from 'node:path'
import { JournalHostDatabase } from './journal-host-database'
import { replayJournal, type JournalLoad } from './journal-open'
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
