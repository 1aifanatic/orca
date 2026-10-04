/**
 * The pointer-delivery lane for workers that ARE a structured agent session.
 *
 * The PTY lane types the nudge into a live pane and reads the idle edge off the terminal title.
 * Neither exists here, so this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a
 * branch inside it: batch selection is literally shared (`owedPointerBatch`), and
 * everything below it is different — the nudge is a session turn, a busy chat holds it as a card in
 * its own queue (the one a person's message waits in), and only an `accepted` dispatch may consume
 * mail. The card is a projection of the mailbox: the queue asks this lane about it again as it
 * sends (`judgeQueuedCard`), so it goes out counting the mail owed then, or not at all.
 *
 * Coordinators are in scope here, unlike the PTY lane's reasoning: a PTY coordinator blocks in
 * `check --wait`, where a waiter preempts pointer delivery, but a structured coordinator is a chat
 * session whose turn ends — so nothing else would ever prompt it for its own `run:` mail.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import { judgeMailNotice, mailNoticeBody, owedPointerBatch } from './structured-mail-notice'
import { resolveStructuredPointerOperation } from './structured-pointer-operation-id'
import {
  readMailboxNoticeCards,
  type StructuredPointerCard,
  type StructuredPointerFacts
} from './structured-pointer-notice-cards'
import { structuredPointerSource, type PointerBatchMessage } from './structured-pointer-source'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import type { QueuedAgentCardVerdict } from '../../native-chat/agent-session-wire/structured-agent-session-queued-agent-card'
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
   * handle outside any dispatch. Nothing downstream needs a dispatch to deliver — it only scopes
   * the operation-ledger budget — so a worker between dispatches is nudged, not dropped.
   */
  dispatchId: string | null
}

type ParkedPointerDelivery = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  /** The chat was busy: the pointer waits as a card its queue sends when the turn ends. */
  | { kind: 'queued'; state: StructuredPointerCard['state'] }
  | { kind: 'unattached' }

export type StructuredMailboxPointerHost = {
  /** Read off the session's full journal and its draft cards; `null` when it cannot be read. */
  readFacts: (sessionId: string) => Promise<StructuredPointerFacts | null>
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
    /** Who the notice speaks for, kept on the card a busy chat queues it as. */
    source: AgentMessageSource
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
  host: StructuredMailboxPointerHost
  onRetain?: (input: {
    mailboxHandle: string
    sessionId: string
    reason: StructuredPointerRetainReason
  }) => void
}

type PointerBatch = readonly PointerBatchMessage[]

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> {
  private readonly inFlight = new Set<string>()
  /** Mailboxes asked about while their attempt was in flight, whose answer may already be stale. */
  private readonly askedInFlight = new Set<string>()
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
    void this.deliver(mailboxHandle, target, reservedTypes).catch(() => {
      // Durable mail stays available to an explicit check or the next settle edge.
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
      void this.deliver(mailboxHandle, target, parked.reservedTypes).catch(() => undefined)
    }
  }

  /** The queue's judge of this lane's notice as it is about to send (`judgeMailNotice`). */
  judgeQueuedCard(input: {
    sessionId: string
    source: AgentMessageSource
  }): QueuedAgentCardVerdict {
    return judgeMailNotice(
      {
        db: this.deps.getDb(),
        hostCanResolve: (sessionId) => this.deps.host.currentFence(sessionId) !== null,
        resolveStructuredTarget: this.deps.resolveStructuredTarget,
        getMessageWaiters: this.deps.getMessageWaiters,
        getCliCommand: this.deps.getCliCommand
      },
      input
    )
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
    // Nothing will reconcile its rows again; a send of its still in flight has no session left.
    this.deps.getDb()?.deleteStructuredPointerOperationsForSession(sessionId)
  }

  private async deliver(
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>
  ): Promise<void> {
    const db = this.deps.getDb()
    if (!db) {
      return
    }
    if (this.inFlight.has(mailboxHandle)) {
      this.askedInFlight.add(mailboxHandle)
      return
    }
    this.inFlight.add(mailboxHandle)
    try {
      const unread = owedPointerBatch(
        db,
        mailboxHandle,
        this.deps.getMessageWaiters(mailboxHandle),
        reservedTypes
      )
      if (unread.length > 0) {
        await this.attempt(db, mailboxHandle, target, unread, reservedTypes)
      } else {
        await this.stampHandedOff(db, mailboxHandle, target)
        await this.retire(db, mailboxHandle)
      }
    } finally {
      this.inFlight.delete(mailboxHandle)
    }
    const current = this.askedInFlight.delete(mailboxHandle)
      ? this.deps.resolveStructuredTarget(mailboxHandle)
      : null
    if (current) {
      void this.deliver(mailboxHandle, current, reservedTypes).catch(() => undefined)
    }
  }

  /**
   * Mail owed no pointer may still be mail a queued notice carried: the agent opened it in the
   * notice's own turn, so an open batch now holds it. An accepted hand-off stamps exactly the ids it
   * carried, as an accepted direct send does, whatever the mail's state since.
   */
  private async stampHandedOff(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget
  ): Promise<void> {
    const unstamped = db
      .getUndeliveredUnreadMessages(mailboxHandle, undefined, {
        limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
      })
      .map((message) => message.id)
    const facts = unstamped.length > 0 ? await this.deps.host.readFacts(target.sessionId) : null
    if (!facts) {
      return
    }
    const { pointed } = readMailboxNoticeCards(mailboxHandle, facts, unstamped)
    const stamped = unstamped.filter((id) => pointed.has(id))
    if (stamped.length > 0) {
      db.markAsDelivered(stamped)
    }
  }

  /**
   * The mailbox owes no pointer: its mail was read, or a consumer or waiter holds it. A card still
   * queued for it is the drain's to withdraw. The row goes unless its send is still in flight, so a
   * batch that comes back replays it rather than sending twice.
   */
  private async retire(db: OrchestrationDb, mailboxHandle: string): Promise<void> {
    const row = db.getStructuredPointerOperation(mailboxHandle)
    if (!row) {
      return
    }
    const facts = await this.deps.host.readFacts(row.session_id)
    const sent = facts?.submissions.find((entry) => entry.clientMessageId === row.operation_id)
    if (sent?.dispatchState !== 'pending') {
      this.forgetOperation(db, mailboxHandle)
    }
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    unread: PointerBatch,
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<void> {
    const sessionId = target.sessionId
    const facts = await this.deps.host.readFacts(sessionId)
    const fence = facts ? this.deps.host.currentFence(sessionId) : null
    if (!facts || fence === null) {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return
    }
    const cards = readMailboxNoticeCards(
      mailboxHandle,
      facts,
      unread.map((message) => message.id)
    )
    // Mail a notice already pointed at counts as pointed, so only newer mail points again.
    const pointed = unread.filter((message) => cards.pointed.has(message.id))
    if (pointed.length > 0) {
      db.markAsDelivered(pointed.map((message) => message.id))
    }
    const row = db.getStructuredPointerOperation(mailboxHandle)
    if (row && cards.ids.has(row.operation_id)) {
      // The send became a card, which carries it from here.
      this.forgetOperation(db, mailboxHandle)
    }
    // One card per mailbox: the drain restates it with whatever arrives meanwhile.
    const waitFor = cards.waiting ? 'queued' : cards.unsettled
    if (waitFor) {
      this.retain(mailboxHandle, sessionId, waitFor, reservedTypes)
      return
    }
    const owed = unread.filter((message) => !cards.pointed.has(message.id))
    if (owed.length === 0) {
      return
    }
    const staged = owed.map((message) => message.id)
    const operation = resolveStructuredPointerOperation({
      db,
      mailboxHandle,
      sessionId,
      messageIds: staged,
      submissions: facts.submissions,
      sentByThisProcess: this.sentOperationIds.get(mailboxHandle)
    })
    if (operation.kind === 'stamp') {
      // A send this lane gave up waiting on ran after all.
      this.stamp(db, mailboxHandle, staged)
      return
    }
    if (operation.kind === 'park') {
      this.retain(mailboxHandle, sessionId, 'send-unsettled', reservedTypes)
      return
    }
    this.sentOperationIds.set(mailboxHandle, operation.operationId)
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId: operation.operationId,
      expectedRuntimeFence: fence,
      body: mailNoticeBody(mailboxHandle, owed.length, this.deps.getCliCommand()),
      source: structuredPointerSource({
        db,
        mailboxHandle,
        dispatchId: target.dispatchId,
        batch: owed
      })
    })
    switch (outcome.kind) {
      case 'unattached':
        this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
        return
      case 'queued':
        // The card carries the send from here; its hand-off is the next edge.
        this.forgetOperation(db, mailboxHandle)
        this.retain(mailboxHandle, sessionId, 'queued', reservedTypes)
        return
      case 'sent':
        if (structuredDispatchDelivered(outcome.state)) {
          // The nudge landed as its own turn, so the next settle edge is the natural retry point
          // for anything that arrives while it runs.
          this.stamp(db, mailboxHandle, staged)
        } else {
          // The row stays: resending under its id replays this verdict and starts nothing.
          this.retain(
            mailboxHandle,
            sessionId,
            retainReasonForDispatch(outcome.state),
            reservedTypes
          )
        }
    }
  }

  /** No `markAsUndelivered` is ever owed: mail is marked delivered only once a pointer to it was
   *  accepted or declined. */
  private stamp(db: OrchestrationDb, mailboxHandle: string, staged: readonly string[]): void {
    db.markAsDelivered([...staged])
    this.forgetOperation(db, mailboxHandle)
  }

  private forgetOperation(db: OrchestrationDb, mailboxHandle: string): void {
    db.deleteStructuredPointerOperation(mailboxHandle)
    this.sentOperationIds.delete(mailboxHandle)
    this.parkedUntilJournalEdge.delete(mailboxHandle)
  }

  /**
   * Every reason parks for the session's next journal edge. `queued` waits for the queue's hand-off
   * to settle; `unknown` may mean the nudge already sits in the provider's input queue, so an
   * immediate retry can stack duplicate nudges; `session-not-attached` and `dispatch-rejected` park
   * because nothing else notices the re-attach or the moved lease, and the dispatch preamble tells
   * workers not to poll.
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
