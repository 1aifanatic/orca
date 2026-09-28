// The host's one chat journal database: every structured chat on this state directory, in one
// file, on one connection, opened only by the process holding the owner lock.
//
// A chat's store owns no connection. It goes through this object, so there is nothing per chat to
// open, close, retry or leak, and the connection closes exactly once, last, at host teardown.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { reclaimFreePagesStep } from '../../sqlite/sqlite-free-page-reclaim'
import { openJournalDatabase } from './journal-database'
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
    if (!this.connection) {
      throw new AgentSessionJournalError('journal_closed', 'the chat journal database is closed')
    }
    return this.connection
  }

  /** One IMMEDIATE transaction. `run` is synchronous by contract: an await inside it would let
   *  another chat's statements land in this transaction on the shared connection. */
  transaction<T>(run: (db: Database.Database) => T): T {
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    let result: T
    try {
      result = run(db)
      if (result instanceof Promise) {
        throw new Error('a chat journal transaction must not await')
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.exec('COMMIT')
    return result
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

  /** Last, after every store has drained. */
  close(): void {
    const connection = this.connection
    this.connection = null
    connection?.close()
  }

  private async runReclaim(): Promise<void> {
    try {
      await yieldToEventLoop()
      let previous = Number.POSITIVE_INFINITY
      while (this.connection) {
        const remaining = reclaimFreePagesStep(this.connection)
        // A step that frees nothing (a file created without incremental auto-vacuum) ends the pass.
        if (remaining === 0 || remaining >= previous) {
          return
        }
        previous = remaining
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
