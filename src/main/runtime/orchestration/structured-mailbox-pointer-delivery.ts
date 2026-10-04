/**
 * The mail-delivery lane for agents that ARE a structured agent session.
 *
 * The PTY lane types a pointer into a live pane and reads the idle edge off the terminal title.
 * Neither exists here, so this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a
 * branch inside it: batch selection is literally shared (`selectOrchestrationPointerBatch`), and
 * everything below it is different. The batch itself is the turn, sent as a person's message is:
 * a busy chat holds it as a card in its own queue, which sends it when the turn ends. Mail is read
 * once the chat accepts that turn; a card the person deletes leaves its mail unread for `check`.
 * What a card or send holds is derived each pass (`structured-chat-mail.ts`), never stamped here.
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
import { resolveStructuredPointerOperation } from './structured-pointer-operation-id'
import {
  reconcileChatMail,
  withChatMailLock,
  type StructuredChatMail,
  type StructuredChatMailHost,
  type StructuredMailCard
} from './structured-chat-mail'
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
  /** The host refused before anything started: a full queue, say. Nothing to replay. */
  | { kind: 'refused' }
  | { kind: 'unattached' }

export type StructuredMailboxPointerHost = StructuredChatMailHost & {
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
  /** The chat this process last queued each mailbox's card in. */
  private readonly queuedIn = new Map<string, string>()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    const released = this.releaseMovedCard(mailboxHandle, target?.sessionId)
    if (!target) {
      return false
    }
    void released
      .then(() => this.deliver(mailboxHandle, target, reservedTypes))
      .catch(() => {
        // Durable mail stays available to an explicit check or the next settle edge.
      })
    return true
  }

  /** The mailbox left the chat this process last queued its card in: that card must not send
   *  there too. That chat's own pass covers a card queued before a restart. */
  private releaseMovedCard(mailboxHandle: string, sessionId: string | undefined): Promise<unknown> {
    const previous = this.queuedIn.get(mailboxHandle)
    if (previous === undefined || previous === sessionId) {
      return Promise.resolve()
    }
    this.queuedIn.delete(mailboxHandle)
    return this.reconcile(previous).catch(() => undefined)
  }

  /** The session's journal or queue moved — a turn settled, a re-attach replayed it, a card was
   *  withdrawn; reconcile its mail, and retry what is parked on that edge. */
  onJournalActivity(sessionId: string): void {
    void this.reconcile(sessionId).catch(() => undefined)
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
    if (this.selectBatch(db, mailboxHandle, reservedTypes).length === 0) {
      return
    }
    this.inFlight.add(mailboxHandle)
    try {
      await this.attempt(db, mailboxHandle, target, reservedTypes)
    } finally {
      this.inFlight.delete(mailboxHandle)
    }
  }

  private reconcile(sessionId: string): Promise<unknown> {
    return withChatMailLock(sessionId, async () => {
      const db = this.deps.getDb()
      const mail = db ? await this.deps.host.readChatMail(sessionId) : null
      return db && mail && this.reconcileWith(db, sessionId, mail)
    })
  }

  private reconcileWith(
    db: OrchestrationDb,
    sessionId: string,
    mail: StructuredChatMail
  ): Promise<readonly StructuredMailCard[]> {
    return reconcileChatMail({
      db,
      sessionId,
      mail,
      host: this.deps.host,
      ownsMailbox: (mailbox) => this.deps.resolveStructuredTarget(mailbox)?.sessionId === sessionId
    })
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<void> {
    const sessionId = target.sessionId
    await withChatMailLock(sessionId, async () => {
      const mail = await this.deps.host.readChatMail(sessionId)
      const fence = mail ? this.deps.host.currentFence(sessionId) : null
      if (!mail || fence === null) {
        this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
        return
      }
      const cards = await this.reconcileWith(db, sessionId, mail)
      if (cards.some((card) => card.mailbox === mailboxHandle)) {
        // One card per mailbox in the queue: what arrives meanwhile goes in the next, never this one.
        this.retain(mailboxHandle, sessionId, 'queued', reservedTypes)
        return
      }
      if (
        mail.sends.some(
          (send) => send.mailbox === mailboxHandle && send.dispatchState === 'pending'
        )
      ) {
        this.retain(mailboxHandle, sessionId, 'turn-unsettled', reservedTypes)
        return
      }
      const batch = this.selectBatch(db, mailboxHandle, reservedTypes)
      if (batch.length > 0) {
        await this.send(db, mailboxHandle, target, fence, mail, batch, reservedTypes)
      }
    })
  }

  private async send(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    fence: number,
    mail: StructuredChatMail,
    batch: readonly MessageRow[],
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<void> {
    const sessionId = target.sessionId
    const staged = batch.map((message) => message.id)
    const operationId = resolveStructuredPointerOperation({
      db,
      mailboxHandle,
      sessionId,
      messageIds: staged,
      submissions: mail.submissions,
      sentByThisProcess: this.sentOperationIds.get(mailboxHandle)
    })
    this.sentOperationIds.set(mailboxHandle, operationId)
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId,
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
        this.endOperation(db, mailboxHandle)
        this.queuedIn.set(mailboxHandle, sessionId)
        this.retain(mailboxHandle, sessionId, 'queued', reservedTypes)
        return
      case 'refused':
        // Nothing started, so the next attempt is a new send, not a replay of this refusal.
        this.endOperation(db, mailboxHandle)
        this.retain(mailboxHandle, sessionId, 'dispatch-rejected', reservedTypes)
        return
      case 'sent':
        if (structuredDispatchDelivered(outcome.state)) {
          db.markAsReadAndDelivered(staged)
          this.endOperation(db, mailboxHandle)
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

  private selectBatch(
    db: OrchestrationDb,
    mailboxHandle: string,
    reservedTypes: ReadonlySet<string> | undefined
  ): MessageRow[] {
    return selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters: this.deps.getMessageWaiters(mailboxHandle),
      reservedTypes
    })
  }

  private endOperation(db: OrchestrationDb, mailboxHandle: string): void {
    db.deleteStructuredPointerOperation(mailboxHandle)
    this.sentOperationIds.delete(mailboxHandle)
  }

  /**
   * Nothing is stamped on the mail to undo: a card or an unsettled send holds it only while it exists.
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
