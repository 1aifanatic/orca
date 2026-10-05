// The chat's stored status (journal_session_state). Every append folds its rows inside its
// transaction and writes the status from that fold there, so a stored status never describes rows
// that did not commit; a failed transaction puts the fold back. An epoch's new fold, and a chat an
// older build last wrote, get theirs here too.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { beginJournalFoldUndo, type JournalFoldUndo } from './journal-fold-undo'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { applyJournalRow, type JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  deleteJournalSessionStatus,
  deriveJournalSessionStatus,
  hasJournalSessionStatus,
  writeJournalSessionStatus
} from './journal-session-state'
import {
  JournalStatusProjection,
  type JournalStatusProjectionState
} from './journal-status-projection'

export type JournalSessionStatusHost = {
  identity: AgentSessionJournalIdentity
  state: () => JournalReducerState
  database: () => JournalHostDatabase
  /** A per-chat file's copy is still owed: the fold is not the database's yet. */
  importPending: () => boolean
  /** The conversation's fence, which the stored status reads as the status feed does. */
  currentFence: () => number | undefined
  /** The undo failed too: the fold is re-read before its next use, never served as it is. */
  markFoldStale: () => void
  notifyCommitted: () => void
}

/** What the store hands its readers: the projection, and the backfill an open runs. */
export type JournalSessionStatusAccess = Pick<JournalSessionStatusWriter, 'at' | 'backfill'>

export class JournalSessionStatusWriter {
  private readonly projection: JournalStatusProjection
  // The open append's undo: what its rows changed in the fold, put back if its transaction fails.
  private undo: JournalFoldUndo | null = null

  constructor(private readonly host: JournalSessionStatusHost) {
    this.projection = new JournalStatusProjection(host.state)
  }

  /** The status projection at this tip, projected once per commit for every reader. */
  at = (fence: number | undefined): JournalStatusProjectionState => this.projection.at(fence)

  /** `live`: the store's own fold, whose projection the status feed shares; an epoch's new fold
   *  projects its own. Decided by the caller, so nothing reads the store's fold inside the
   *  transaction. */
  write(db: Database.Database, state: JournalReducerState, live: boolean): void {
    const currentFence = this.host.currentFence()
    writeJournalSessionStatus(
      db,
      this.host.identity.sessionId,
      deriveJournalSessionStatus(state, {
        currentFence,
        ...(live ? { statusSummary: () => this.projection.at(currentFence).summary } : {})
      })
    )
  }

  /** Inside an append's transaction: folds its rows under one undo. */
  apply(rows: readonly JournalRow[]): void {
    const state = this.host.state()
    this.undo = beginJournalFoldUndo(state)
    for (const row of rows) {
      applyJournalRow(state, row)
    }
  }

  /** Inside an append's transaction, after `apply`: the status of the fold that holds its rows. */
  writeAppended(db: Database.Database): void {
    this.write(db, this.host.state(), true)
  }

  /** After the append's COMMIT. */
  committed(): void {
    this.undo?.commit()
    this.undo = null
    this.host.notifyCommitted()
  }

  /**
   * An append whose transaction failed after its rows were folded: the undo puts back what they
   * changed. If it cannot (it throws, or a row removed an entry, which no undo puts back in its
   * place), the fold is marked stale and folded again from what committed before its next use (the
   * host database rolls a stranded transaction back before it hands out the connection, so that
   * re-read never sees the failed rows).
   */
  recover(): void {
    // What the projection read of the failed rows must not answer for the next ones at their seq.
    this.projection.invalidate()
    const failed = this.undo
    this.undo = null
    try {
      if (failed?.rollback()) {
        return
      }
    } catch (error) {
      console.warn('[agent-session-journal] undoing a failed append failed', {
        sessionId: this.host.identity.sessionId,
        error
      })
    }
    this.host.markFoldStale()
  }

  /** A load whose open fails (damage, or a newer build's rows) drops the chat's row, so no startup
   *  selects it again; an open that succeeds writes it back. Bookkeeping: a failure only logs. */
  forgetUnloadable = (load: JournalLoad): void => {
    const database = this.host.database()
    if ((!load.newer && !load.damage) || database.readOnly) {
      return
    }
    try {
      database.transaction((db) => deleteJournalSessionStatus(db, this.host.identity.sessionId))
    } catch (error) {
      console.warn('[agent-session-journal] dropping an unloadable chat status failed', {
        sessionId: this.host.identity.sessionId,
        error
      })
    }
  }

  /** Writes the chat's status if it has none: a chat an older build last wrote. Bookkeeping: a
   *  failure leaves the chat without a row, which its next open writes again. */
  backfill = (): void => {
    const { host } = this
    const database = host.database()
    if (database.readOnly || host.importPending()) {
      return
    }
    try {
      // Read before the transaction: a stale fold is re-read from disk, never inside one.
      const state = host.state()
      database.transaction((db) => {
        if (!hasJournalSessionStatus(db, host.identity.sessionId)) {
          this.write(db, state, true)
        }
      })
    } catch (error) {
      console.warn('[agent-session-journal] writing a chat status failed', {
        sessionId: host.identity.sessionId,
        error
      })
    }
  }
}
