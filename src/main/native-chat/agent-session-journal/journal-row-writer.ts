import type Database from '../../sqlite/sync-database'
import { insertJournalRow } from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'

/** Runs between BEGIN IMMEDIATE and COMMIT, on the SAME connection as the row
 *  insert; a throw rolls the whole append back. Synchronous by construction so
 *  nothing can interleave inside the transaction. */
export type JournalRowTransactionHook = (db: Database.Database, row: JournalRow) => void

/** An operation's ledger answer, committed with the journal write that makes it true: `write` runs
 *  inside that transaction on the same connection, `committed` synchronously right after its
 *  COMMIT and never after a rollback. */
export type JournalOperationReceipt = {
  write: (db: Database.Database) => void
  committed: () => void
}

export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  /** Folds the append's rows inside its transaction, so the status written with them describes them. */
  apply: (rows: readonly JournalRow[]) => void
  /** The chat's status from the fold that now holds the rows. A throw fails the append. */
  writeStatus: (db: Database.Database, rows: readonly JournalRow[]) => void
  /** After COMMIT: observers learn of the rows only once they are durable. */
  committed: (rows: readonly JournalRow[]) => void
  /** A transaction that failed after `apply`: the fold is ahead of the disk, so it is folded
   *  again from what committed. */
  recoverFold: () => void
  /** Standing hook run for EVERY appended row — the queued-draft returned
   *  transition rides here so no rejection path can bypass it. Bookkeeping: it
   *  runs in its own savepoint, so its failure is reported and never vetoes the row. */
  inTransaction?: JournalRowTransactionHook
  /** After any rollback, so a cache filled inside the transaction cannot outlive it. */
  rolledBack?: () => void
}

const BOOKKEEPING_SAVEPOINT = 'journal_row_bookkeeping'

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    hook?: JournalRowTransactionHook,
    receipt?: JournalOperationReceipt
  ): Promise<JournalRow> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const row = build(this.deps.nextSequence(), this.deps.now())
      assertJournalFence(row.fence, this.deps.highestFence())
      this.writeRows([row], hook, receipt)
      return row
    })
  }

  /** Several rows in ONE transaction, in order, planned once the lane is this append's: none is
   *  durable unless all are, so no reader ever meets some without the rest. */
  enqueueRows(
    plan: () => readonly ((seq: number, ts: number) => JournalRow)[]
  ): Promise<JournalRow[]> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const first = this.deps.nextSequence()
      const ts = this.deps.now()
      const rows = plan().map((build, index) => build(first + index, ts))
      if (rows.length === 0) {
        return rows
      }
      for (const row of rows) {
        assertJournalFence(row.fence, this.deps.highestFence())
      }
      this.writeRows(rows)
      return rows
    })
  }

  /** Assign the next sequence, make the row durable, and fold it through the SAME reducer
   *  replay uses — all inside one serialized step — answering where the row landed. */
  append(
    build: (seq: number, ts: number) => JournalRow,
    hook?: JournalRowTransactionHook,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.enqueue(build, hook, receipt).then((row) => ({
      epoch: row.epoch,
      sequence: row.seq
    }))
  }

  /** One transaction: every row, then the receipt, then the fold and the status it gives. */
  private writeRows(
    rows: readonly JournalRow[],
    hook?: JournalRowTransactionHook,
    receipt?: JournalOperationReceipt
  ): void {
    let applied = false
    try {
      // One INSERT per row: the chat's epoch pointer moves only when the epoch does. The hook and
      // the bookkeeping read the fold before the rows; the status reads it after all of them.
      this.deps.database().transaction((db) => {
        for (const row of rows) {
          insertJournalRow(db, this.deps.sessionId, row)
          hook?.(db, row)
          this.runBookkeeping(db, row)
        }
        receipt?.write(db)
        applied = true
        this.deps.apply(rows)
        this.deps.writeStatus(db, rows)
      })
    } catch (error) {
      this.deps.rolledBack?.()
      if (applied) {
        this.deps.recoverFold()
      }
      throw error
    }
    // The ledger first: it cannot throw, observers can.
    receipt?.committed()
    this.deps.committed(rows)
  }

  private runBookkeeping(db: Database.Database, row: JournalRow): void {
    const hook = this.deps.inTransaction
    if (!hook) {
      return
    }
    db.exec(`SAVEPOINT ${BOOKKEEPING_SAVEPOINT}`)
    try {
      hook(db, row)
      db.exec(`RELEASE ${BOOKKEEPING_SAVEPOINT}`)
    } catch (error) {
      db.exec(`ROLLBACK TO ${BOOKKEEPING_SAVEPOINT}`)
      db.exec(`RELEASE ${BOOKKEEPING_SAVEPOINT}`)
      this.deps.rolledBack?.()
      // The draft store re-derives what this missed from the committed rows: at open, and in
      // the drain step before a draft sends.
      console.warn('[journal-append] row bookkeeping skipped:', {
        sessionId: this.deps.sessionId,
        kind: row.kind,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
