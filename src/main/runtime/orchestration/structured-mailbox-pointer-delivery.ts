/**
 * The pointer-delivery lane for workers that ARE a structured agent session.
 *
 * The PTY lane types the nudge into a live pane and reads the idle edge off the terminal title.
 * Neither exists here, so this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a
 * branch inside it: batch selection is literally shared (`selectOrchestrationPointerBatch`), and
 * everything below it is different — the nudge is a session turn, a busy chat holds it as a card in
 * its own queue (the one a person's message waits in), and only an `accepted` dispatch may consume
 * mail. The card is a projection of the mailbox: the lane withdraws it once its mail is read, and
 * re-derives it from orchestration's database after a restart.
 *
 * Coordinators are in scope here, unlike the PTY lane's reasoning: a PTY coordinator blocks in
 * `check --wait`, where a waiter preempts pointer delivery, but a structured coordinator is a chat
 * session whose turn ends — so nothing else would ever prompt it for its own `run:` mail.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  resolveStructuredPointerOperation,
  structuredPointerRowCovers,
  structuredPointerSendState,
  type StructuredPointerCard,
  type StructuredPointerFacts
} from './structured-pointer-operation-id'
import { structuredPointerSource, type PointerBatchMessage } from './structured-pointer-source'
import type { QueuedMessageAgentSource } from '../../../shared/queued-message-source'
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
    source: QueuedMessageAgentSource
  }) => Promise<StructuredPointerSendOutcome>
  /** Withdraws the lane's own card; false when the host could not be asked. */
  withdraw: (input: { sessionId: string; messageId: string }) => Promise<boolean>
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

  /**
   * Mail was read. A card still queued for it would reach the agent after it already has the mail,
   * so every mailbox holding a pointer is re-derived now, and resolves once a card owed nothing is
   * withdrawn: before the reader sees its mail, so before its turn can end and the queue send it.
   * Retire-only, so it never waits on a send; replacing a card is the next edge's job.
   */
  async onMailRead(): Promise<void> {
    const rows = this.deps.getDb()?.listStructuredPointerOperations?.() ?? []
    await Promise.all(
      rows.map(({ mailbox_handle: mailboxHandle }) =>
        this.deliver(
          mailboxHandle,
          null,
          this.parkedUntilJournalEdge.get(mailboxHandle)?.reservedTypes
        ).catch(() => undefined)
      )
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
  }

  /** `target` null: the mailbox has no session to point right now, but its stale card can go. */
  private async deliver(
    mailboxHandle: string,
    target: StructuredPointerTarget | null,
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
      await this.reconcile(db, mailboxHandle, target, reservedTypes)
    } finally {
      this.inFlight.delete(mailboxHandle)
    }
    if (this.askedInFlight.delete(mailboxHandle)) {
      const current = this.deps.resolveStructuredTarget(mailboxHandle)
      void this.deliver(mailboxHandle, current, reservedTypes).catch(() => undefined)
    }
  }

  private async reconcile(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget | null,
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<void> {
    // A consumer still holding an unacknowledged batch is owed no pointer. The lookup is keyed on
    // the exact handle being nudged, so a coordinator's own `run:` delivery is invisible to a
    // worker's `dispatch:` gate and cannot suppress the nudges a coordinator sends its workers.
    // Worth more here than in the PTY lane: a structured nudge costs a whole provider turn.
    const unread = db.hasOutstandingMailboxDelivery?.(mailboxHandle)
      ? []
      : selectOrchestrationPointerBatch({
          db,
          mailboxHandle,
          waiters: this.deps.getMessageWaiters(mailboxHandle),
          reservedTypes
        })
    if (unread.length === 0) {
      await this.retire(db, mailboxHandle)
      return
    }
    if (target) {
      await this.attempt(db, mailboxHandle, target, unread, reservedTypes)
    }
  }

  /**
   * The mailbox owes no pointer: its mail was read, or a consumer or waiter holds it. A card still
   * queued for it is withdrawn, never sent stale, and the row goes. A send still in flight keeps
   * its row, so a batch that comes back replays it rather than sending twice.
   */
  private async retire(db: OrchestrationDb, mailboxHandle: string): Promise<void> {
    const row = db.getStructuredPointerOperation(mailboxHandle)
    const facts = row ? await this.deps.host.readFacts(row.session_id) : null
    if (!row || !facts) {
      return
    }
    const state = structuredPointerSendState(row.operation_id, facts)
    if (state === 'pending') {
      return
    }
    if (state === 'queued' && !(await this.withdrawCard(row.session_id, row.operation_id))) {
      return
    }
    this.forgetOperation(db, mailboxHandle)
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
    const staged = unread.map((message) => message.id)
    if (!(await this.withdrawSupersededCard(db, mailboxHandle, sessionId, staged, facts))) {
      this.retain(mailboxHandle, sessionId, 'queued', reservedTypes)
      return
    }
    const operation = resolveStructuredPointerOperation({
      db,
      mailboxHandle,
      sessionId,
      messageIds: staged,
      facts,
      sentByThisProcess: this.sentOperationIds.get(mailboxHandle)
    })
    switch (operation.kind) {
      // A send this lane gave up waiting on ran after all, or the queue sent its card; or the person
      // deleted the card, so this batch counts as pointed and only newer mail points again.
      case 'stamp':
      case 'declined':
        this.stamp(db, mailboxHandle, staged)
        return
      case 'park':
        this.retain(mailboxHandle, sessionId, 'send-unsettled', reservedTypes)
        return
      case 'queued':
        this.retain(mailboxHandle, sessionId, 'queued', reservedTypes)
        return
      case 'send':
        break
    }
    this.sentOperationIds.set(mailboxHandle, operation.operationId)
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId: operation.operationId,
      expectedRuntimeFence: fence,
      body: this.pointerBody(mailboxHandle, unread.length),
      source: structuredPointerSource({
        db,
        mailboxHandle,
        dispatchId: target.dispatchId,
        batch: unread
      })
    })
    switch (outcome.kind) {
      case 'unattached':
        this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
        return
      case 'queued':
        // Withdrawn only on a replay of a card the person deleted since.
        if (outcome.state === 'withdrawn') {
          this.stamp(db, mailboxHandle, staged)
        } else {
          this.retain(mailboxHandle, sessionId, 'queued', reservedTypes)
        }
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

  /**
   * A card queued for an older batch, or in another session, is about to be replaced: withdraw it
   * first, so the chat never holds two pointers or one naming mail already read. False when it is
   * still queued and the host could not be asked.
   */
  private async withdrawSupersededCard(
    db: OrchestrationDb,
    mailboxHandle: string,
    sessionId: string,
    staged: readonly string[],
    facts: StructuredPointerFacts
  ): Promise<boolean> {
    const row = db.getStructuredPointerOperation(mailboxHandle)
    if (!row || structuredPointerRowCovers(row, sessionId, staged)) {
      return true
    }
    const rowFacts =
      row.session_id === sessionId ? facts : await this.deps.host.readFacts(row.session_id)
    if (!rowFacts || structuredPointerSendState(row.operation_id, rowFacts) !== 'queued') {
      return true
    }
    return this.withdrawCard(row.session_id, row.operation_id)
  }

  private withdrawCard(sessionId: string, messageId: string): Promise<boolean> {
    return this.deps.host.withdraw({ sessionId, messageId }).catch(() => false)
  }

  private pointerBody(mailboxHandle: string, count: number): AgentJournalMessageItem {
    const text = formatMessagePointer(count, mailboxHandle, this.deps.getCliCommand()).trim()
    return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }

  /** No `markAsUndelivered` is ever owed: rows are marked delivered only here. */
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
