// The journal's draft-store collaborator: every read and write of one session's
// `queued_messages` rows, serialized on the same queue as the journal's own
// appends so a draft mutation can never interleave with the consume that
// converts it. Drafts are NEVER owed work: nothing here feeds the reducer,
// working status, teardown, or the idle sweep.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../shared/agent-session-host-authority'
import {
  journalDispatchRowNewlyRejects,
  submissionRefusalReturnsDraft
} from './journal-dispatch-settlement'
import { dispatchWasWithdrawn } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  consumeQueuedMessageInTransaction,
  getQueuedMessage,
  insertQueuedMessage,
  listQueuedMessages,
  pruneQueuedMessages,
  queuedMessagesSettledByOp,
  returnDispatchedQueuedMessage,
  withdrawQueuedMessages,
  type QueuedMessageRow
} from './queued-message-table'
import { AgentSessionJournalError, assertJournalWritable } from './journal-write-guards'

/** Tombstones must outlive the window in which their operation id could still be admitted as new. */
export const QUEUED_MESSAGE_REPLAY_WINDOW_MS =
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS

export type JournalQueuedMessagesDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  database: () => { db: Database.Database }
  readOnly: () => boolean
  state: () => JournalReducerState
}

export class JournalQueuedMessages {
  /** Bumped on every draft-table write, so publication memos recompute only when they must. */
  private changeRevision = 0

  constructor(private readonly deps: JournalQueuedMessagesDeps) {}

  revision(): number {
    return this.changeRevision
  }

  list(): QueuedMessageRow[] {
    return listQueuedMessages(this.deps.database().db, this.deps.sessionId)
  }

  get(messageId: string): QueuedMessageRow | null {
    return getQueuedMessage(this.deps.database().db, this.deps.sessionId, messageId)
  }

  /** Replay receipts for one caller-scoped operation key. */
  receipts(settledByOp: string): QueuedMessageRow[] {
    return queuedMessagesSettledByOp(this.deps.database().db, this.deps.sessionId, settledByOp)
  }

  insert(input: {
    messageId: string
    body: AgentJournalMessageItem
    fingerprint: string
    hostInstance: string
  }): Promise<QueuedMessageRow> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const { db } = this.deps.database()
      const existing = getQueuedMessage(db, this.deps.sessionId, input.messageId)
      if (existing) {
        // One id, one draft: admission replays a recorded operation before it
        // gets here, so an existing row is the same accept landing twice.
        return existing
      }
      const row = insertQueuedMessage(db, {
        ...input,
        sessionId: this.deps.sessionId,
        now: this.deps.now()
      })
      this.changeRevision++
      return row
    })
  }

  /** Compare-and-transition waiting ∪ returned rows to op-stamped tombstones; the
   *  returned rows' bodies come back too, so a Stop or clear restores their text. */
  withdraw(input: {
    messageIds: readonly string[]
    settledByOp: string
  }): Promise<QueuedMessageRow[]> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const { db } = this.deps.database()
      db.exec('BEGIN IMMEDIATE')
      let withdrawn: QueuedMessageRow[]
      try {
        withdrawn = withdrawQueuedMessages(db, {
          sessionId: this.deps.sessionId,
          messageIds: input.messageIds,
          settledByOp: input.settledByOp,
          now: this.deps.now()
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      if (withdrawn.length > 0) {
        this.changeRevision++
      }
      return withdrawn
    })
  }

  /**
   * The standing writer hook: within the append's transaction, transition a
   * `dispatched` draft to `returned` only when the row being committed NEWLY
   * settles the draft's current consumed submission to a non-withdrawn
   * rejection. Decided by the same function the reducer folds rows through, so
   * a row the journal's settlement rules ignore never alters a draft.
   */
  onRowInTransaction(db: Database.Database, row: JournalRow): void {
    if (row.kind !== 'dispatch' || row.state !== 'rejected') {
      return
    }
    const submission = this.deps.state().submissions.get(row.clientMessageId)
    if (!journalDispatchRowNewlyRejects(submission, row)) {
      return
    }
    if (
      returnDispatchedQueuedMessage(db, {
        sessionId: this.deps.sessionId,
        consumedRef: row.clientMessageId,
        reason: row.reason,
        now: this.deps.now()
      })
    ) {
      this.changeRevision++
    }
  }

  /** The in-transaction consume for `appendSubmission`; a false compare-and-set
   *  throws so the whole append — draft transition AND submission row — rolls back. */
  consumeInTransaction(
    db: Database.Database,
    input: {
      messageId: string
      expect: 'waiting' | 'returned'
      consumedAs: string
      settledByOp: string | null
    }
  ): void {
    const { db: own } = this.deps.database()
    if (own !== db) {
      // Same handle only: a second connection could not join the transaction.
      throw new AgentSessionJournalError('journal_closed', 'consume crossed database handles')
    }
    const consumed = consumeQueuedMessageInTransaction(db, {
      ...input,
      sessionId: this.deps.sessionId,
      now: this.deps.now()
    })
    if (!consumed) {
      throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
    }
    this.changeRevision++
  }

  /**
   * Open-time reconciliation, a re-derivation behind the stored fact: any
   * `dispatched` row whose loaded current submission is effectively rejected
   * becomes `returned` (covers consume → crash → downgrade → upgrade, where the
   * old build rejected the leftover with no hook), then retention runs.
   */
  repairAndPrune(): Promise<void> {
    return this.deps.serialize(async () => {
      if (this.deps.readOnly()) {
        return
      }
      const { db } = this.deps.database()
      const submissions = this.deps.state().submissions
      const now = this.deps.now()
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of listQueuedMessages(db, this.deps.sessionId)) {
          if (row.state !== 'dispatched') {
            continue
          }
          const submission = submissions.get(row.consumedAs ?? row.messageId)
          if (submissionRefusalReturnsDraft(submission)) {
            returnDispatchedQueuedMessage(db, {
              sessionId: this.deps.sessionId,
              consumedRef: row.consumedAs ?? row.messageId,
              reason: submission?.reason ?? null,
              now
            })
          }
        }
        pruneQueuedMessages(db, {
          sessionId: this.deps.sessionId,
          now,
          replayWindowMs: QUEUED_MESSAGE_REPLAY_WINDOW_MS,
          submissionVerdict: (consumedRef) => {
            const submission = submissions.get(consumedRef)
            if (!submission) {
              return 'absent'
            }
            if (submission.dispatchState === 'accepted' || submission.dispatchState === 'unknown') {
              return 'terminal-not-refused'
            }
            if (submission.dispatchState !== 'rejected') {
              return 'pending'
            }
            // The repair above already returned every effectively-refused row, so
            // a still-dispatched rejected one was withdrawn by its user's Stop —
            // settled, owed to nobody, and releasable once the window passes.
            return dispatchWasWithdrawn(submission) ? 'terminal-not-refused' : 'rejected'
          }
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      this.changeRevision++
    })
  }
}

/** The per-append hook converting one draft inside the append's own transaction. */
export function queuedMessageConsumeHook(
  queuedMessages: JournalQueuedMessages,
  consumedAs: string,
  consume: { messageId: string; expect: 'waiting' | 'returned'; settledByOp: string | null }
): (db: Database.Database) => void {
  return (db) =>
    queuedMessages.consumeInTransaction(db, {
      messageId: consume.messageId,
      expect: consume.expect,
      consumedAs,
      settledByOp: consume.settledByOp
    })
}

export class QueuedMessageNotConsumableError extends Error {
  constructor(
    readonly messageId: string,
    readonly expected: 'waiting' | 'returned'
  ) {
    super(`queued message ${messageId} is no longer ${expected}`)
    this.name = 'QueuedMessageNotConsumableError'
  }
}
