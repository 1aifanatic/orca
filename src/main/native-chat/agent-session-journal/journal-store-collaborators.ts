// Wiring for the store's collaborators.
//
// Split out of the store itself so the class stays a description of the public
// surface rather than sixty lines of constructor plumbing.

import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalEpochController } from './journal-epoch-controller'
import { JournalItemAppender } from './journal-item-appender'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalLoad } from './journal-open'
import { JournalQueuedMessages } from './journal-queued-messages'
import type { JournalReducerState } from './journal-reducer'
import { JournalRowWriter } from './journal-row-writer'
import { restoreJournalStore } from './journal-store-restore'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import type Database from '../../sqlite/sync-database'
import { applyJournalRow } from './journal-reducer'
import { readJournalRowsAfterCursor, replayJournal } from './journal-open'
import { readJournalSince } from './journal-cursor'
import type { JournalReadSince } from './journal-store-contracts'
import {
  deriveJournalSessionState,
  ensureJournalSessionStateCurrent,
  writeJournalSessionState
} from './journal-session-state'

export type JournalStoreHost = {
  /** Fires the journal's commit listener for a durable change that appended no
   *  row — a standalone draft-table transaction — so readers learn of it the
   *  same way they learn of a row. */
  notifyCommitted: () => void
  identity: AgentSessionJournalIdentity
  /** Where the chat's per-chat history lived, for the importer and the format-remnant notice. */
  legacyDirectory: string
  now: () => number
  mintEpoch: () => string
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  /** Leave a chat still in its per-chat file uncopied until its first use. */
  deferPerSessionImport: boolean
  /** Work the chat's next write waits for. */
  owe: (work: () => Promise<void>) => void
  database: () => JournalHostDatabase
  state: () => JournalReducerState
  readOnly: () => boolean
  setReadOnly: (readOnly: boolean) => void
  cursor: () => AgentJournalCursor
  adopt: (loaded: JournalLoad) => void
  /** Replaces the fold alone, quietly: a failed append's re-fold from disk. */
  replaceState: (state: JournalReducerState) => void
  /** The chat can no longer trust its fold or its connection: refuses every later write. */
  strand: () => void
  /** Whether this open's replay found an unusable prefix. */
  openedCorrupt: () => boolean
  /** The conversation's fence, which the stored status reads as the status feed does. */
  currentFence: () => number | undefined
  /** A per-chat file's copy is still owed: the fold is not the database's yet. */
  importPending: () => boolean
  /** Records whether the open's replay found an unusable prefix. */
  setOpenedCorrupt: (corrupt: boolean) => void
  malformedRows: () => number
  setMalformedRows: (count: number) => void
  journal: () => AgentSessionJournal
  enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
}

export type JournalStoreCollaborators = {
  rowWriter: JournalRowWriter
  epochController: JournalEpochController
  itemAppender: JournalItemAppender
  lifecycleBatchAppender: JournalLifecycleBatchAppender
  queuedMessages: JournalQueuedMessages
  /** Restores the store's state from disk. Owned here because it needs the same
   *  collaborators the constructor just built. */
  restore: () => Promise<void>
  ensureSessionState: () => void
  readSince: (cursor: AgentJournalCursor, limit?: number) => JournalReadSince
}

export function createJournalStoreCollaborators(host: JournalStoreHost): JournalStoreCollaborators {
  const writeState = (db: Database.Database, state: JournalReducerState) =>
    writeJournalSessionState(
      db,
      host.identity.sessionId,
      deriveJournalSessionState(state, journalSessionStateInput(host)),
      host.now()
    )
  const epochController = new JournalEpochController({
    identity: host.identity,
    now: host.now,
    mintEpoch: host.mintEpoch,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    setReadOnly: host.setReadOnly,
    highestFence: () => host.state().highestFence,
    cursor: host.cursor,
    adopt: host.adopt,
    writeState
  })
  const queuedMessages = new JournalQueuedMessages({
    sessionId: host.identity.sessionId,
    now: host.now,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    state: host.state,
    committed: host.notifyCommitted
  })
  return {
    epochController,
    queuedMessages,
    ensureSessionState: () => ensureStoredSessionState(host),
    readSince: (cursor, limit) =>
      readJournalSince(
        {
          state: host.state(),
          rowsAfter: (afterSequence) =>
            readJournalRowsAfterCursor(
              host.database().db,
              host.identity.sessionId,
              host.state().epoch,
              afterSequence,
              limit
            ),
          readOnly: host.readOnly()
        },
        cursor,
        host.cursor
      ),
    // Behind the stored fact: settles drafts whose consumed submission the loaded journal shows
    // refused (a downgrade wrote no hook), then prunes. Bookkeeping, never failing the open.
    restore: () =>
      restoreJournalStore(host, { epochController }).then(() =>
        queuedMessages.repairAndPruneAtOpen()
      ),
    rowWriter: new JournalRowWriter({
      sessionId: host.identity.sessionId,
      now: host.now,
      serialize: host.serialize,
      database: host.database,
      readOnly: host.readOnly,
      highestFence: () => host.state().highestFence,
      nextSequence: () => host.state().lastSequence + 1,
      apply: (row) => applyJournalRow(host.state(), row),
      committed: host.notifyCommitted,
      recoverFold: () => recoverJournalFold(host),
      writeState: (db) => writeState(db, host.state()),
      // Every rejection is a dispatch row through this one writer; the draft
      // returned-transition rides it so no path can bypass the hook.
      inTransaction: (db, row) => queuedMessages.onRowInTransaction(db, row),
      rolledBack: () => queuedMessages.invalidate()
    }),
    itemAppender: new JournalItemAppender({
      state: host.state,
      enqueue: host.enqueue
    }),
    lifecycleBatchAppender: new JournalLifecycleBatchAppender({
      state: host.state,
      cursor: host.cursor,
      enqueue: host.enqueue
    })
  }
}

function journalSessionStateInput(host: Pick<JournalStoreHost, 'openedCorrupt' | 'currentFence'>) {
  return { settlesRosters: !host.openedCorrupt(), currentFence: host.currentFence() }
}

function ensureStoredSessionState(host: JournalStoreHost): void {
  const database = host.database()
  if (host.readOnly() || database.readOnly || host.importPending()) {
    return
  }
  try {
    ensureJournalSessionStateCurrent(
      database.db,
      host.state(),
      journalSessionStateInput(host),
      host.now()
    )
  } catch (error) {
    console.warn('[agent-session-journal] re-deriving the stored chat state failed', {
      sessionId: host.identity.sessionId,
      error
    })
  }
}

/**
 * An append whose transaction failed after its row was folded: the fold is ahead of the disk, and
 * an in-place apply cannot be undone, so the chat is folded again from what committed. A stranded
 * connection may still hold the uncommitted row, so a re-read would adopt it: the chat closes
 * instead, and its next open reads the disk once the host database's own rollback goes through.
 */
function recoverJournalFold(
  host: Pick<JournalStoreHost, 'database' | 'identity' | 'replaceState' | 'strand'>
): void {
  const database = host.database()
  if (!database.isStranded) {
    try {
      const reloaded = replayJournal(database.db, host.identity.sessionId)
      if (reloaded) {
        host.replaceState(reloaded.state)
        return
      }
    } catch (error) {
      console.warn('[agent-session-journal] re-folding after a failed append failed', error)
    }
  }
  host.strand()
}
