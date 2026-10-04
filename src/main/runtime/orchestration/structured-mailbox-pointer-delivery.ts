/**
 * The mail-delivery lane for agents that ARE a structured agent session.
 *
 * The PTY lane types a pointer into a live pane and reads the idle edge off the terminal title.
 * Neither exists here, so this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a
 * branch inside it: batch selection is literally shared (`selectOrchestrationPointerBatch`), and
 * everything below it is different. The batch itself is the turn, sent as a person's message is:
 * a busy chat holds it as a card in its own queue, which sends it when the turn ends. Mail is read
 * once the chat accepts that turn; a card the person deletes leaves its mail unread for `check`.
 *
 * Coordinators are in scope here, unlike the PTY lane's reasoning: a PTY coordinator blocks in
 * `check --wait`, where a waiter preempts pointer delivery, but a structured coordinator is a chat
 * session whose turn ends — so nothing else would ever prompt it for its own `run:` mail.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import type { MessageRow, OrchestrationDb } from './db'
import { formatMessageTurn } from './formatter'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import { structuredMailSource } from './structured-mail-source'
import {
  resolveStructuredPointerOperation,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'
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
  /** The chat was busy: the turn waits as a card its queue sends when the turn ends. */
  | { kind: 'queued' }
  | { kind: 'unattached' }

/** A card in the chat's queue that carries orchestration mail, whatever became of it. */
export type StructuredMailCard = {
  mailbox: string
  messageIds: readonly string[]
  /** Still in the queue: waiting for it to send, or returned to the person. */
  unsent: boolean
  /** Its hand-off was accepted: the chat took the mail. */
  accepted: boolean
}

export type StructuredMailFacts = {
  /** Every send the session recorded, oldest first: what the lane's own direct sends settled as. */
  submissions: readonly StructuredPointerSubmission[]
  mailCards: readonly StructuredMailCard[]
}

export type StructuredMailboxPointerHost = {
  /** The session's recorded sends and mail cards; `null` when it cannot be read. */
  readFacts: (sessionId: string) => Promise<StructuredMailFacts | null>
  /** Only the cards whose hand-off ran; cheap when none has. */
  readHandedOffMailCards: (sessionId: string) => Promise<readonly StructuredMailCard[] | null>
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
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
  /** The CLI name the PTY lane types for a local agent, so both lanes name the same command. */
  getCliCommand: () => OrchestrationCliCommand
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
    void this.deliver(mailboxHandle, target, reservedTypes).catch(() => {
      // Durable mail stays available to an explicit check or the next settle edge.
    })
    return true
  }

  /** The session's journal moved — a turn settled, or a re-attach replayed it; mark the mail its
   *  queue handed off read, and retry what is parked on that edge. */
  onJournalActivity(sessionId: string): void {
    void this.readAcceptedMail(sessionId).catch(() => undefined)
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
    reservedTypes?: ReadonlySet<string>
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
      return
    }
    this.inFlight.add(mailboxHandle)
    try {
      await this.attempt(db, mailboxHandle, target, unread, reservedTypes)
    } finally {
      this.inFlight.delete(mailboxHandle)
    }
  }

  private async readAcceptedMail(sessionId: string): Promise<void> {
    const db = this.deps.getDb()
    const cards = db ? await this.deps.host.readHandedOffMailCards(sessionId) : null
    if (db && cards) {
      markAcceptedMailRead(db, cards)
    }
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    unread: readonly MessageRow[],
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<void> {
    const sessionId = target.sessionId
    const facts = await this.deps.host.readFacts(sessionId)
    const fence = facts ? this.deps.host.currentFence(sessionId) : null
    if (!facts || fence === null) {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return
    }
    markAcceptedMailRead(db, facts.mailCards)
    if (facts.mailCards.some((card) => card.mailbox === mailboxHandle && card.unsent)) {
      // One card per mailbox in the queue: what arrives meanwhile goes in the next, never this one.
      this.retain(mailboxHandle, sessionId, 'queued', reservedTypes)
      return
    }
    // Mail a card already carries (one queued just before a restart) is never sent twice.
    const carried = new Set(facts.mailCards.flatMap((card) => card.messageIds))
    const repeated = unread.filter((message) => carried.has(message.id))
    if (repeated.length > 0) {
      db.markAsDelivered(repeated.map((message) => message.id))
    }
    const batch = unread.filter((message) => !carried.has(message.id))
    if (batch.length === 0) {
      return
    }
    const staged = batch.map((message) => message.id)
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
      this.consume(db, mailboxHandle, staged, 'read')
      return
    }
    if (operation.kind === 'park') {
      this.retain(mailboxHandle, sessionId, 'turn-unsettled', reservedTypes)
      return
    }
    this.sentOperationIds.set(mailboxHandle, operation.operationId)
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId: operation.operationId,
      expectedRuntimeFence: fence,
      body: mailTurnBody(batch, this.deps.getCliCommand()),
      source: structuredMailSource({
        db,
        mailboxHandle,
        dispatchId: target.dispatchId,
        batch
      })
    })
    switch (outcome.kind) {
      case 'unattached':
        this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
        return
      case 'queued':
        // The card carries it from here; it is read once its hand-off is accepted.
        this.consume(db, mailboxHandle, staged, 'delivered')
        this.retain(mailboxHandle, sessionId, 'queued', reservedTypes)
        return
      case 'sent':
        if (structuredDispatchDelivered(outcome.state)) {
          this.consume(db, mailboxHandle, staged, 'read')
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

  /** The send is done with: the chat took the mail (`read`), or a card now carries it. */
  private consume(
    db: OrchestrationDb,
    mailboxHandle: string,
    staged: string[],
    as: 'read' | 'delivered'
  ): void {
    if (as === 'read') {
      db.markAsReadAndDelivered(staged)
    } else {
      db.markAsDelivered(staged)
    }
    db.deleteStructuredPointerOperation(mailboxHandle)
    this.sentOperationIds.delete(mailboxHandle)
  }

  /**
   * No `markAsUndelivered` is owed: rows are marked delivered only once the chat accepted them or a
   * card in its queue carries them.
   *
   * Every reason parks for the session's next journal edge. `queued` sends what arrived while the
   * card waited once it has gone. `unknown` may mean the turn already sits in the provider's input
   * queue, so an immediate retry can stack duplicate turns; `session-not-attached` and
   * `dispatch-rejected` park because nothing else notices the re-attach or the moved lease, and the
   * dispatch preamble tells workers not to poll.
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

/** The batch as one turn: each message in mail order, each naming its sender. */
function mailTurnBody(
  batch: readonly MessageRow[],
  cli: OrchestrationCliCommand
): AgentJournalMessageItem {
  const text = batch.map((message) => formatMessageTurn(message, cli)).join('\n\n')
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

/** The chat took these: `check` must not return them again. */
function markAcceptedMailRead(db: OrchestrationDb, cards: readonly StructuredMailCard[]): void {
  const unread = cards
    .filter((card) => card.accepted)
    .flatMap((card) => card.messageIds)
    .filter((id) => db.getMessageById(id)?.read === 0)
  if (unread.length > 0) {
    db.markAsReadAndDelivered(unread)
  }
}
