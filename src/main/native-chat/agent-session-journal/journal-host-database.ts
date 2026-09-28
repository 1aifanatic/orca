// The host's one chat journal database: every structured chat on this state directory, in one
// file, on one connection, opened only by the process holding the owner lock.
//
// A chat's store owns no connection. It goes through this object, so there is nothing per chat to
// open, close, retry or leak, and the connection closes exactly once, last, at host teardown.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { freePageCount, reclaimFreePagesStep } from '../../sqlite/sqlite-free-page-reclaim'
import { JOURNAL_SYNCHRONOUS, openJournalDatabase, runJournalTransaction } from './journal-database'
import { journalOpenRefusalError } from './journal-open-failure'
import type { JournalOwnerLock } from './journal-owner-lock'
import { journalDirectoryFor } from './journal-paths'
import { AgentSessionJournalError } from './journal-write-guards'

export const JOURNAL_DATABASE_FILE = 'agent-session-journal.db'

export function journalDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, JOURNAL_DATABASE_FILE)
}

export class JournalHostDatabase {
  private connection: Database.Database | null
  private reclaiming: Promise<void> | null = null
  /** A failed transaction's ROLLBACK failed too, so the transaction may still be open. */
  private stranded = false

  private constructor(
    readonly stateDirectory: string,
    connection: Database.Database
  ) {
    this.connection = connection
  }

  /** Takes the lock as proof of ownership: no other path opens this file. */
  static open(lock: JournalOwnerLock): JournalHostDatabase {
    if (!lock.isHeld) {
      throw new Error('the chat journal opens only under a held owner lock')
    }
    const stateDirectory = lock.stateDirectory
    return new JournalHostDatabase(
      stateDirectory,
      openJournalDatabase(journalDatabasePath(stateDirectory))
    )
  }

  get isClosed(): boolean {
    return this.connection === null
  }

  get db(): Database.Database {
    const connection = this.connection
    if (!connection) {
      throw new AgentSessionJournalError('journal_closed', 'the chat journal database is closed')
    }
    if (this.stranded) {
      this.rollBackStrandedTransaction(connection)
    }
    return connection
  }

  /** One IMMEDIATE transaction; see `runJournalTransaction`. */
  transaction<T>(run: (db: Database.Database) => T): T {
    return runJournalTransaction(this.db, run, () => {
      this.stranded = true
    })
  }

  /**
   * The same transaction, committed without an fsync: for rows no reader follows until a later
   * synced commit, which under WAL makes every earlier frame durable too. The setting is restored
   * in the same task, so no other chat's commit runs under it.
   */
  unsyncedTransaction<T>(run: (db: Database.Database) => T): T {
    const db = this.db
    db.pragma('synchronous = NORMAL')
    try {
      return this.transaction(run)
    } finally {
      // SQLite refuses the change inside a transaction; freeing a stranded one restores it.
      if (!db.isTransaction) {
        db.pragma(`synchronous = ${JOURNAL_SYNCHRONOUS}`)
      }
    }
  }

  /** Where this chat's history lived before the journal was one database per host. */
  legacyDirectoryFor(
    identity: Pick<AgentSessionJournalIdentity, 'workspaceId' | 'sessionId'>
  ): string {
    return journalDirectoryFor(this.stateDirectory, identity)
  }

  /**
   * Hands the pages a delete freed back to the filesystem, one bounded step per turn of the event
   * loop, after the transaction that freed them. Called by everything that deletes rows. Passes
   * coalesce: one already running picks up whatever the new delete freed.
   */
  reclaimFreePages(): Promise<void> {
    this.reclaiming ??= this.runReclaim()
    return this.reclaiming
  }

  /** Last, after every store has drained. A close that fails keeps the handle, so the retried
   *  teardown closes this same connection before the owner lock goes. */
  close(): void {
    this.connection?.close()
    this.connection = null
  }

  /**
   * A failed transaction whose ROLLBACK failed too is still open: every later BEGIN would fail
   * inside it and every read would see rows that never committed. Each use retries the ROLLBACK,
   * and until one goes through every chat is refused the way a journal that will not open is.
   */
  private rollBackStrandedTransaction(connection: Database.Database): void {
    if (connection.isTransaction) {
      try {
        connection.exec('ROLLBACK')
      } catch (error) {
        throw journalOpenRefusalError(error)
      }
    }
    connection.pragma(`synchronous = ${JOURNAL_SYNCHRONOUS}`)
    this.stranded = false
  }

  private async runReclaim(): Promise<void> {
    try {
      await yieldToEventLoop()
      while (!this.isClosed) {
        const db = this.db
        const before = freePageCount(db)
        const remaining = reclaimFreePagesStep(db)
        // A step that frees nothing (a file created without incremental auto-vacuum) ends the pass;
        // pages a delete freed since the last step do not.
        if (remaining === 0 || remaining >= before) {
          return
        }
        await yieldToEventLoop()
      }
    } catch (error) {
      // Bookkeeping: a failed step only leaves pages for the next delete's pass.
      console.warn('[agent-session-journal] reclaiming freed pages failed', error)
    } finally {
      // Cleared as the pass ends, not a microtask later, so a delete right after starts a new one.
      this.reclaiming = null
    }
  }
}
