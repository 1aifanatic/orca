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
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { adoptQueuedMessages, holdQueuedMessages } from './queued-message-holds'
import {
  clearQueuePause,
  readQueuePause,
  recordQueuePause,
  type QueuePauseFact,
  type QueuePauseReason
} from './queued-message-pause-table'
import {
  consumeQueuedMessageInTransaction,
  getQueuedMessage,
  insertQueuedMessage,
  listQueuedMessages,
  queuedMessagesSettledByOp,
  withdrawQueuedMessages,
  type QueuedMessageHoldReason,
  type QueuedMessageRow
} from './queued-message-table'
import { draftsDeliveredByAppliedEcho } from './queued-message-delivered-echo'
import { pruneQueuedMessages } from './queued-message-retention'
import {
  queuedMessageSettlementOwed,
  settleOwedQueuedMessages,
  settleQueuedMessagesForRow
} from './queued-message-settlement'
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
  /** The journal's own commit notification. Every standalone draft-table
   *  transaction that changed rows fires it after COMMIT, so a draft or hold
   *  change publishes and wakes the drain through the same path a journal row
   *  does — no call site can forget. In-transaction consume and the returned
   *  transition already ride their row's own commit. */
  committed: () => void
}

export class JournalQueuedMessages {
  /** Bumped on every draft-table write, so publication memos recompute only when they must. */
  private changeRevision = 0
  private listed: { revision: number; rows: readonly QueuedMessageRow[] } | null = null
  private paused: { revision: number; fact: QueuePauseFact | null } | null = null

  constructor(private readonly deps: JournalQueuedMessagesDeps) {}

  revision(): number {
    return this.changeRevision
  }

  /** A journal transaction rolled back: nothing read inside it may stay cached. */
  invalidate(): void {
    this.changeRevision++
  }

  /** Cached per revision: the drain re-checks on every journal publish, so an
   *  unchanged table must cost no SQL read or body parse on token streams. */
  list(): readonly QueuedMessageRow[] {
    if (this.listed?.revision !== this.changeRevision) {
      this.listed = {
        revision: this.changeRevision,
        rows: listQueuedMessages(this.deps.database().db, this.deps.sessionId)
      }
    }
    return this.listed.rows
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
      this.deps.committed()
      return row
    })
  }

  /** Hold one waiting draft whose conversion failed. Stored on the row, so it
   *  survives handle eviction and restart; withdraw and consume clear it in their
   *  own UPDATE. */
  hold(input: { messageIds: readonly string[]; reason: QueuedMessageHoldReason }): Promise<void> {
    return this.transact(
      (db) => holdQueuedMessages(db, { ...input, sessionId: this.deps.sessionId }),
      (held) => held > 0
    ).then(() => undefined)
  }

  /** Where the user's last Stop took effect, if it is still recorded; cached per revision. */
  pause(): QueuePauseFact | null {
    if (this.paused?.revision !== this.changeRevision) {
      this.paused = {
        revision: this.changeRevision,
        fact: readQueuePause(this.deps.database().db, this.deps.sessionId)
      }
    }
    return this.paused.fact
  }

  /** A Stop (or a /clear's carry) took effect here: the queue is paused from this position on. */
  recordPause(reason: QueuePauseReason): Promise<void> {
    const { epoch, lastSequence: sequence } = this.deps.state()
    const fact: QueuePauseFact = { reason, epoch, sequence, recordedAt: this.deps.now() }
    return this.transact(
      (db) => recordQueuePause(db, { sessionId: this.deps.sessionId, fact }),
      () => true
    )
  }

  /** Ends the queue's pause: `stop` retires that Stop fact (never a later one),
   *  `adoptInto` adopts a restart's rows into this host instance. Returns whether
   *  anything changed. */
  liftPause(input: { stop: QueuePauseFact | null; adoptInto: string | null }): Promise<boolean> {
    const { sessionId } = this.deps
    return this.transact(
      (db) =>
        (input.stop ? clearQueuePause(db, { sessionId, fact: input.stop }) : 0) +
        (input.adoptInto === null
          ? 0
          : adoptQueuedMessages(db, { sessionId, hostInstance: input.adoptInto })),
      (changed) => changed > 0
    ).then((changed) => changed > 0)
  }

  /** Compare-and-transition waiting ∪ returned rows to op-stamped tombstones,
   *  kept only so a replay of the settling operation answers "spent". */
  withdraw(input: {
    messageIds: readonly string[]
    settledByOp: string
  }): Promise<QueuedMessageRow[]> {
    if (input.messageIds.length === 0) {
      // Delete races and empty carries land here; neither may cost a write transaction.
      return Promise.resolve([])
    }
    return this.transact(
      (db) =>
        withdrawQueuedMessages(db, {
          ...input,
          sessionId: this.deps.sessionId,
          now: this.deps.now()
        }),
      (withdrawn) => withdrawn.length > 0
    )
  }

  /** One standalone draft-table transaction on the journal's queue; one that
   *  changed rows bumps the revision and notifies after COMMIT. */
  private transact<T>(
    run: (db: Database.Database) => T,
    changed: (result: T) => boolean
  ): Promise<T> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const { db } = this.deps.database()
      db.exec('BEGIN IMMEDIATE')
      let result: T
      try {
        result = run(db)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      if (changed(result)) {
        this.changeRevision++
        this.deps.committed()
      }
      return result
    })
  }

  /** The standing writer hook, within the append's transaction
   *  (`settleQueuedMessagesForRow`). */
  onRowInTransaction(db: Database.Database, row: JournalRow): void {
    this.changeRevision += settleQueuedMessagesForRow(db, {
      sessionId: this.deps.sessionId,
      state: this.deps.state(),
      drafts: () => this.list(),
      row,
      now: this.deps.now()
    })
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

  /** A skipped live settlement the journal already decided (`queued-message-settlement.ts`). */
  settlementOwed(): boolean {
    return queuedMessageSettlementOwed(this.list(), this.deps.state().submissions)
  }

  /** Waiting drafts a skipped echo hook left unwithdrawn; reads every item, so only the drain
   *  step asks, right before a draft would send. */
  deliveredByEchoOwed(): boolean {
    return draftsDeliveredByAppliedEcho(this.deps.state(), this.list()).length > 0
  }

  /** Applies owed settlements now, so a skipped live transition heals without a reopen. */
  settleOwed(): Promise<void> {
    return this.transact(
      (db) =>
        settleOwedQueuedMessages(db, {
          sessionId: this.deps.sessionId,
          state: this.deps.state(),
          now: this.deps.now()
        }),
      (settled) => settled > 0
    ).then(() => undefined)
  }

  /** Bookkeeping at open: a failure is reported and retried at the next open,
   *  never allowed to fail opening the chat. */
  repairAndPruneAtOpen(): Promise<void> {
    return this.repairAndPrune().catch((error: unknown) => {
      console.warn('[journal-open] queued-message repair skipped:', {
        sessionId: this.deps.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  /**
   * Open-time reconciliation, a re-derivation behind the stored fact: owed
   * settlements apply exactly as the live hook would have (covers consume →
   * crash → downgrade → upgrade, where the old build rejected the leftover with
   * no hook), then retention runs.
   */
  repairAndPrune(): Promise<void> {
    return this.deps.serialize(async () => {
      if (this.deps.readOnly()) {
        return
      }
      const { db } = this.deps.database()
      const submissions = this.deps.state().submissions
      const now = this.deps.now()
      let changed = 0
      db.exec('BEGIN IMMEDIATE')
      try {
        changed += settleOwedQueuedMessages(db, {
          sessionId: this.deps.sessionId,
          state: this.deps.state(),
          now
        })
        changed += pruneQueuedMessages(db, {
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
            // The repair above already settled every rejected row.
            return submission.dispatchState === 'rejected' ? 'rejected' : 'pending'
          }
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      if (changed > 0) {
        this.changeRevision++
        this.deps.committed()
      }
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
