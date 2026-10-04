// The serialized drain: converts one queued draft into an ordinary submission when the session
// stops owing work. Woken by every journal commit; each step re-derives every gate, so there is no
// loop state to disagree with the journal.

import { randomUUID } from 'node:crypto'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/journal-queued-messages'
import { queueShowsCard } from '../agent-session-journal/queued-message-pause'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  drainableQueuedCard,
  type QueuedAgentCardJudge
} from './structured-agent-session-queued-agent-card'
import {
  oldestActionableQueuedMessage,
  structuredQueueHold
} from './structured-agent-session-queued-messages'

export type QueuedMessageDrainDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  conversationFence: (sessionId: string) => number
  /** The consumed submission is ordinary #22821 work from here on. */
  wakeDelivery: (sessionId: string) => void
  judgeAgentCard: QueuedAgentCardJudge
  /** An agent's card the host withdrew unsent; whoever queued it re-derives it. */
  agentCardDropped: (input: { sessionId: string; source: AgentMessageSource }) => void
  logger: StructuredAgentSessionLogger
}

/**
 * The serialized drain. Woken by every journal commit (turn, submission, prompt,
 * command and Stop settlements are all commits), by draft mutations, and by the
 * conversation opening; each step re-derives everything and consumes at most one
 * draft — the consumed submission then owes work, which gates the next.
 */
export class StructuredAgentSessionQueuedMessageDrain {
  private readonly scheduled = new Set<string>()

  constructor(private readonly deps: QueuedMessageDrainDeps) {}

  schedule(sessionId: string): void {
    const journal = this.deps.sessions.get(sessionId)?.journal
    if (!journal || journal.isReadOnly) {
      return
    }
    // Cheap pre-check so token streams do not pay a serialized step per delta.
    // Skipping while working is safe: whatever ends the work is itself a commit
    // that schedules again, and the step re-reads every gate from the fold.
    try {
      if (
        !journal.queuedMessages.settlementOwed() &&
        (oldestActionableQueuedMessage(journal) === null ||
          isStructuredAgentSessionMainAgentWorking(
            journal.activeTurnId(),
            journal.submissions(),
            this.deps.conversationFence(sessionId)
          ))
      ) {
        return
      }
    } catch {
      // The handle is opening or closing; the next commit re-schedules.
      return
    }
    if (this.scheduled.has(sessionId)) {
      return
    }
    this.scheduled.add(sessionId)
    void this.deps
      .serialize(sessionId, () => {
        this.scheduled.delete(sessionId)
        return this.step(sessionId)
      })
      .catch((error: unknown) => {
        this.scheduled.delete(sessionId)
        this.deps.logger.warn('draining queued messages failed', {
          scope: 'queued-drain',
          sessionId,
          error
        })
      })
  }

  private async step(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || session.journal.isReadOnly) {
      return
    }
    const journal = session.journal
    if (journal.queuedMessages.settlementOwed() || journal.queuedMessages.deliveredByEchoOwed()) {
      // A live per-row hook was skipped; heal now, before a draft sends, rather than at reopen.
      await journal.queuedMessages.settleOwed().catch((error: unknown) => {
        this.deps.logger.warn('settling owed queued-message bookkeeping failed', {
          scope: 'queued-settle-owed',
          sessionId,
          error
        })
      })
    }
    const next = oldestActionableQueuedMessage(journal)
    if (!next) {
      return
    }
    const record = this.deps.getRecord(sessionId)
    const fence = this.deps.conversationFence(sessionId)
    // Live facts only, through the one gate; the backlog is never a gate, so a
    // lone draft drains. Whatever clears a hold publishes or commits, which
    // re-derives this step.
    if (structuredQueueHold({ journal, record, fence }) !== null) {
      return
    }
    const card = drainableQueuedCard({
      sessionId,
      row: next,
      judge: this.deps.judgeAgentCard,
      logger: this.deps.logger
    })
    if (!card) {
      // The host's withdrawal, never read as a person's decline; its commit re-derives this step.
      await journal.queuedMessages.withdraw({ messageIds: [next.messageId], settledByOp: null })
      return
    }
    // Always a fresh id: the submission names its draft by `queuedMessageId`, never by id equality.
    const submissionId = createStructuredAgentSessionOperationId(randomUUID)
    try {
      await journal.appendSubmission(
        {
          clientMessageId: submissionId,
          // The queue's own automatic send: it never ends a pause.
          origin: 'host',
          payloadFingerprint: card.fingerprint,
          body: card.body,
          fence,
          handoverRecorded: true
        },
        {
          messageId: next.messageId,
          expect: 'waiting',
          settledByOp: null,
          hostInstance: structuredAgentSessionHostInstance(),
          yieldsToPause: { hostInstance: structuredAgentSessionHostInstance() },
          ...(card.restated ? { restated: card.restated } : {})
        }
      )
    } catch (error) {
      if (error instanceof QueuedMessageNotConsumableError) {
        // Lost a race with a Send-now, a Delete or a Stop; their transition stands.
        return
      }
      // Pre-consume failure: the draft stays waiting, held with the marker on
      // the card (a stored fact, so it survives eviction and restart). The
      // hold's own commit notification publishes it. An explicit Send retries;
      // no automatic retry loop. A card the person cannot see has no Send: the
      // host withdraws it and hands it back to whoever queued it.
      await (
        next.source.kind === 'agent' && !queueShowsCard(next.source)
          ? this.dropAgentCard(sessionId, journal, next.messageId, next.source)
          : journal.queuedMessages.hold({
              messageIds: [next.messageId],
              reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
            })
      ).catch(() => {})
      throw error
    }
    this.deps.wakeDelivery(sessionId)
  }

  private async dropAgentCard(
    sessionId: string,
    journal: AgentSessionJournal,
    messageId: string,
    source: AgentMessageSource
  ): Promise<void> {
    await journal.queuedMessages.withdraw({ messageIds: [messageId], settledByOp: null })
    this.deps.agentCardDropped({ sessionId, source })
  }
}
