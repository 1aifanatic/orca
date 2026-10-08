// Structured mail uses the chat send path, but waits in its mailbox while the chat is busy.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import type { MessageRow, OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  resolveStructuredPointerOperation,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'
import { structuredMailSource } from './structured-mail-source'
import type { SenderNameResolver } from './agent-message-sender'
import {
  retainReasonForDispatch,
  structuredDispatchDelivered,
  type StructuredDispatchState,
  type StructuredPointerRetainReason
} from './structured-session-pointer-delivery'

export type StructuredPointerTarget = {
  sessionId: string
  /**
   * The dispatch whose mailbox this is, or null for direct peer mail addressed to the worker's own
   * handle outside any dispatch. The dispatch scopes receipt ownership, not delivery eligibility.
   */
  dispatchId: string | null
}

type ParkedPointerDelivery = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  | { kind: 'deferred' }
  /** Replay of a pointer an earlier build already queued. */
  | { kind: 'queued' }
  | { kind: 'unattached' }

export type StructuredPointerSessionFacts = {
  /** Every send the session recorded, oldest first: what the lane's own sends settled as. */
  submissions: readonly StructuredPointerSubmission[]
  operationOutcome?: AgentSessionOperationOutcome
}

export type StructuredMailboxPointerHost = {
  /** `null` when the session cannot be read. */
  readSessionFacts: (
    sessionId: string,
    operation?: {
      dispatchId: string | null
      operationId: string
    }
  ) => Promise<StructuredPointerSessionFacts | null>
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    /** Names its senders as `from`. */
    body: AgentJournalMessageItem
  }) => Promise<StructuredPointerSendOutcome>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
}

type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /**
   * The session a mailbox must be nudged through, or null when a live PTY can take the bytes.
   *
   * The mailbox is a `dispatch:` address or the worker's own bearer handle; the second is how
   * agents mail each other outside a dispatch, and no other lane can serve it.
   */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  /** The CLI name the PTY lane types for a local agent, so both lanes send the same pointer. */
  getCliCommand: () => OrchestrationCliCommand
  /** What Orca calls a sender now, snapshotted onto the message; null when it has no name. */
  senderName: SenderNameResolver
  host: StructuredMailboxPointerHost
  onRetain?: (input: {
    mailboxHandle: string
    sessionId: string
    reason: StructuredPointerRetainReason
  }) => void
}

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> {
  private readonly inFlight = new Set<string>()
  /**
   * Mailboxes whose retry must wait for the session's next journal edge, each remembering the
   * session it is parked ON.
   *
   * Recorded rather than re-resolved: `resolveStructuredTarget` answers null whenever the runtime
   * cannot look — a momentarily null DB reference, a session mid-teardown — and pruning on that
   * absence dropped every OTHER worker's parked entry too, silently costing them their wake-up
   * edge until the next explicit check.
   */
  private readonly parkedUntilJournalEdge = new Map<string, ParkedPointerDelivery>()
  /** The operation id this lane last sent per mailbox: a row holding any other id outlived the
   *  process that minted it. A fact, not a clock reading, so no clock step can fake it. */
  private readonly sentOperationIds = new Map<string, string>()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    if (!target) {
      return false
    }
    void this.deliver(mailboxHandle, target, reservedTypes).catch((error: unknown) => {
      console.warn('[orchestration] structured mail delivery failed', {
        mailboxHandle,
        sessionId: target.sessionId,
        error
      })
    })
    return true
  }

  /** The session's journal moved — a turn settled, or a re-attach replayed it; retry what is
   *  parked on that edge. */
  onJournalActivity(sessionId: string): void {
    for (const [mailboxHandle, parked] of Array.from(this.parkedUntilJournalEdge)) {
      if (parked.sessionId !== sessionId) {
        continue
      }
      this.parkedUntilJournalEdge.delete(mailboxHandle)
      const target = this.deps.resolveStructuredTarget(mailboxHandle)
      if (target?.sessionId !== sessionId) {
        // The mailbox moved off this session (or cannot be resolved right now); its own edge or an
        // explicit check is what retries it, not this session's journal.
        continue
      }
      void this.deliver(mailboxHandle, target, parked.reservedTypes).catch((error: unknown) => {
        console.warn('[orchestration] structured mail redrive failed', {
          mailboxHandle,
          sessionId,
          error
        })
      })
    }
  }

  /**
   * The worker settled; drop what IT had parked, and nothing else.
   *
   * The recorded session id is the whole test. Settlement forgets the worker's identity, so
   * re-resolving the target here would answer null for exactly the entries this is meant to
   * prune — and null for every sibling the runtime momentarily cannot resolve either.
   */
  forgetSession(sessionId: string): void {
    for (const [mailboxHandle, parked] of Array.from(this.parkedUntilJournalEdge)) {
      if (parked.sessionId === sessionId) {
        this.parkedUntilJournalEdge.delete(mailboxHandle)
      }
    }
  }

  private async deliver(
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>,
    attemptedSessions = new Set<string>()
  ): Promise<void> {
    const db = this.deps.getDb()
    if (!db || this.inFlight.has(mailboxHandle)) {
      return
    }
    // Don't re-nudge a mailbox whose consumer still holds an unacknowledged batch. The lookup is
    // keyed on the exact handle being nudged, so a coordinator's own `run:` delivery is invisible
    // to a worker's `dispatch:` gate and cannot suppress the nudges a coordinator sends its
    // workers. Worth more here than in the PTY lane: a structured nudge costs a whole provider
    // turn, not a line of text into a composer.
    if (db.hasOutstandingMailboxDelivery?.(mailboxHandle)) {
      return
    }
    const unread = selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters: this.deps.getMessageWaiters(mailboxHandle),
      reservedTypes
    })
    if (unread.length === 0) {
      if (db.getUndeliveredUnreadMessages(mailboxHandle, undefined, { limit: 1 }).length === 0) {
        db.deleteStructuredPointerOperation(mailboxHandle)
        this.sentOperationIds.delete(mailboxHandle)
      }
      return
    }
    this.inFlight.add(mailboxHandle)
    let redrive = false
    try {
      redrive = await this.attempt(db, mailboxHandle, target, unread, reservedTypes)
    } finally {
      this.inFlight.delete(mailboxHandle)
      // A thrown attempt follows too; its own failure is what still propagates.
      await this.followMovedTarget(mailboxHandle, target, reservedTypes, attemptedSessions).catch(
        () => undefined
      )
    }
    if (
      redrive &&
      this.deps.resolveStructuredTarget(mailboxHandle)?.sessionId === target.sessionId
    ) {
      await this.deliver(mailboxHandle, target, reservedTypes, attemptedSessions)
    }
  }

  /**
   * A `/clear` while the attempt was in flight moved the mailbox to a successor, whose idle edge
   * found it in flight and was dropped; nothing else retries it. Only an actual move retries, so
   * an unchanged rejected or unknown send keeps its suppression, and each session is tried once.
   */
  private async followMovedTarget(
    mailboxHandle: string,
    attempted: StructuredPointerTarget,
    reservedTypes: ReadonlySet<string> | undefined,
    attemptedSessions: Set<string>
  ): Promise<void> {
    attemptedSessions.add(attempted.sessionId)
    const current = this.deps.resolveStructuredTarget(mailboxHandle)
    if (!current || attemptedSessions.has(current.sessionId)) {
      return
    }
    if (this.parkedUntilJournalEdge.get(mailboxHandle)?.sessionId === attempted.sessionId) {
      this.parkedUntilJournalEdge.delete(mailboxHandle)
    }
    await this.deliver(mailboxHandle, current, reservedTypes, attemptedSessions)
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    unread: readonly MessageRow[],
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<boolean> {
    const sessionId = target.sessionId
    let stored = db.getStructuredPointerOperation(mailboxHandle)
    if (
      stored?.message_ids &&
      !stored.message_ids.some((id) => db.areUnreadMessages(mailboxHandle, [id]))
    ) {
      // A check or lifecycle supersession discharged this batch, regardless of its send's verdict.
      db.deleteStructuredPointerOperation(mailboxHandle)
      this.sentOperationIds.delete(mailboxHandle)
      stored = undefined
    }
    const session = await this.deps.host.readSessionFacts(
      sessionId,
      stored?.session_id === sessionId
        ? {
            dispatchId: target.dispatchId,
            operationId: stored.operation_id
          }
        : undefined
    )
    if (!session) {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return false
    }
    const fence = this.deps.host.currentFence(sessionId)
    if (fence === null) {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return false
    }
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: formatMessagePointer(unread.length, mailboxHandle, this.deps.getCliCommand()).trim()
        }
      ],
      from: structuredMailSource({
        db,
        mailboxHandle,
        dispatchId: target.dispatchId,
        batch: unread,
        senderName: this.deps.senderName
      })
    }
    const staged = unread.map((message) => message.id)
    const operation = resolveStructuredPointerOperation({
      db,
      mailboxHandle,
      sessionId,
      messageIds: staged,
      submissions: session.submissions,
      operationOutcome: session.operationOutcome,
      sentByThisProcess: this.sentOperationIds.get(mailboxHandle)
    })
    if (operation.kind === 'stamp') {
      // A send this lane gave up waiting on ran after all.
      db.markAsDelivered(operation.messageIds)
      db.deleteStructuredPointerOperation(mailboxHandle)
      this.sentOperationIds.delete(mailboxHandle)
      return true
    }
    if (operation.kind === 'park') {
      this.retain(mailboxHandle, sessionId, 'turn-unsettled', reservedTypes)
      return false
    }
    this.sentOperationIds.set(mailboxHandle, operation.operationId)
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId: operation.operationId,
      expectedRuntimeFence: fence,
      body
    })
    if (outcome.kind === 'deferred') {
      this.retain(mailboxHandle, sessionId, 'turn-unsettled', reservedTypes)
      return false
    }
    if (outcome.kind === 'unattached') {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return false
    }
    // A legacy queued pointer already belongs to the chat; a new pointer never queues.
    if (outcome.kind === 'sent' && !structuredDispatchDelivered(outcome.state)) {
      // The row stays: resending under its id replays this verdict and starts nothing.
      this.retain(mailboxHandle, sessionId, retainReasonForDispatch(outcome.state), reservedTypes)
      return false
    }
    db.markAsDelivered(staged)
    // The nudge landed as its own turn, so the next settle edge is the natural retry point for
    // anything that arrives while it runs.
    db.deleteStructuredPointerOperation(mailboxHandle)
    this.sentOperationIds.delete(mailboxHandle)
    return false
  }

  /**
   * No `markAsUndelivered` is owed: rows are marked delivered only after an accepted dispatch, or
   * once the chat's queue holds the pointer.
   *
   * Every reason parks for the session's next journal edge. `unknown` may mean the nudge already
   * sits in the provider's input queue, so an immediate retry can stack duplicate nudges;
   * `session-not-attached` and `dispatch-rejected` park because nothing else notices the re-attach
   * or the moved lease, and the dispatch preamble tells workers not to poll.
   */
  private retain(
    mailboxHandle: string,
    sessionId: string,
    reason: StructuredPointerRetainReason,
    reservedTypes: ReadonlySet<string> | undefined
  ): void {
    this.deps.onRetain?.({ mailboxHandle, sessionId, reason })
    this.parkedUntilJournalEdge.set(mailboxHandle, { sessionId, reservedTypes })
  }
}
