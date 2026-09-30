import type Database from '../../sqlite/sync-database'
import { insertJournalRow } from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'

/** Runs between BEGIN IMMEDIATE and COMMIT, on the SAME connection as the row
 *  insert; a throw rolls the whole append back. Synchronous by construction so
 *  nothing can interleave inside the transaction. */
export type JournalRowTransactionHook = (db: Database.Database, row: JournalRow) => void

export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  /** Folds the row, inside the transaction, so the state row below describes it. */
  apply: (row: JournalRow) => void
  /** After COMMIT: observers learn of the row only once it is durable. */
  committed: () => void
  /** A transaction that failed after `apply`: the fold is ahead of the disk. Re-folds from disk,
   *  or closes the chat when the connection is stranded and a re-read would see the row. */
  recoverFold: () => void
  /** Standing hook run for EVERY appended row — the queued-draft returned
   *  transition rides here so no rejection path can bypass it. Bookkeeping: it
   *  runs in its own savepoint, so its failure is reported and never vetoes the row. */
  inTransaction?: JournalRowTransactionHook
  /** The chat's stored state, from the fold that now includes the row. Bookkeeping too. */
  writeState?: (db: Database.Database) => void
  /** After any rollback, so a cache filled inside the transaction cannot outlive it. */
  rolledBack?: () => void
}

const BOOKKEEPING_SAVEPOINT = 'journal_row_bookkeeping'
const STATE_SAVEPOINT = 'journal_session_state'

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    hook?: JournalRowTransactionHook
  ): Promise<JournalRow> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const row = build(this.deps.nextSequence(), this.deps.now())
      assertJournalFence(row.fence, this.deps.highestFence())
      let applied = false
      try {
        // One INSERT: the chat's epoch pointer moves only when the epoch does.
        this.deps.database().transaction((db) => {
          insertJournalRow(db, this.deps.sessionId, row)
          hook?.(db, row)
          this.runBookkeeping(db, row)
          applied = true
          this.deps.apply(row)
          this.runStateWrite(db, row)
        })
      } catch (error) {
        this.deps.rolledBack?.()
        if (applied) {
          this.deps.recoverFold()
        }
        throw error
      }
      // COMMIT landed and the fold already holds the row; only now do observers hear of it.
      this.deps.committed()
      return row
    })
  }

  /** Assign the next sequence, make the row durable, and fold it through the SAME reducer
   *  replay uses — all inside one serialized step — answering where the row landed. */
  append(
    build: (seq: number, ts: number) => JournalRow,
    hook?: JournalRowTransactionHook
  ): Promise<AgentJournalCursor> {
    return this.enqueue(build, hook).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  private runBookkeeping(db: Database.Database, row: JournalRow): void {
    const hook = this.deps.inTransaction
    if (!hook) {
      return
    }
    this.inSavepoint(
      db,
      BOOKKEEPING_SAVEPOINT,
      row,
      () => hook(db, row),
      () => {
        this.deps.rolledBack?.()
        // The draft store re-derives what this missed from the committed rows: at open, and in
        // the drain step before a draft sends.
        return 'row bookkeeping skipped'
      }
    )
  }

  private runStateWrite(db: Database.Database, row: JournalRow): void {
    const write = this.deps.writeState
    if (write) {
      // Left behind the tip on failure, so the next open or startup re-derives it.
      this.inSavepoint(
        db,
        STATE_SAVEPOINT,
        row,
        () => write(db),
        () => 'state row skipped'
      )
    }
  }

  /** Bookkeeping never vetoes the row: its failure rolls back to the savepoint and is reported. */
  private inSavepoint(
    db: Database.Database,
    name: string,
    row: JournalRow,
    run: () => void,
    onFailure: () => string
  ): void {
    db.exec(`SAVEPOINT ${name}`)
    try {
      run()
      db.exec(`RELEASE ${name}`)
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`)
      db.exec(`RELEASE ${name}`)
      console.warn(`[journal-append] ${onFailure()}:`, {
        sessionId: this.deps.sessionId,
        kind: row.kind,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
