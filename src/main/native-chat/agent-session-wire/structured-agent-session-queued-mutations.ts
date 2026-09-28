// `agentSession.queuedMessageSend` / `agentSession.queuedMessageDelete`, and the
// withdraw step Stop (`structured-agent-session-queued-stop.ts`) and /clear share. All three settle drafts into op-stamped
// tombstone receipts, so a lost acknowledgement replays from the rows themselves
// — never from the operation ledger, which records only that an operation
// happened.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionSendResult,
  AgentSessionWithdrawnQueuedMessage
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/journal-queued-messages'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { pendingPromptExists } from './structured-agent-session-queued-messages'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  openForWrite,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import { releaseQueuedMessagePause } from './structured-agent-session-queued-pause'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

function invalid(message: string): {
  ok: false
  refusal: { code: 'agent_session_operation_invalid'; message: string }
} {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

function submissionFor(
  ctx: AgentSessionTurnContext,
  clientMessageId: string
): AgentJournalSubmission | undefined {
  return ctx.journal.submissions().find((entry) => entry.clientMessageId === clientMessageId)
}

/** The one withdrawable-card predicate Stop and /clear share: definitively
 *  unsettled drafts — waiting or returned. Pending/unknown/accepted deliveries
 *  stay outside it. */
export function withdrawableQueuedMessages(journal: AgentSessionJournal): QueuedMessageRow[] {
  return journal.queuedMessages
    .list()
    .filter((row) => row.state === 'waiting' || row.state === 'returned')
}

/** One transaction, stamped with the operation's caller-scoped key; pauses the
 *  rows held are released because withdrawal retires the hold. */
export async function withdrawQueuedMessagesForOperation(
  journal: AgentSessionJournal,
  input: {
    sessionId: string
    messageIds: readonly string[]
    callerKey: string
    operationId: string
  }
): Promise<AgentSessionWithdrawnQueuedMessage[]> {
  const rows = await journal.queuedMessages.withdraw({
    messageIds: input.messageIds,
    settledByOp: agentSessionOperationKey(input.callerKey, input.operationId)
  })
  for (const row of rows) {
    releaseQueuedMessagePause(input.sessionId, row.messageId)
  }
  return rows.map((row) => ({ messageId: row.messageId, body: row.body }))
}

/** /clear's withdrawal of the superseded source's cards. Bookkeeping after the
 *  committed clear: a failure leaves the cards for Delete (the supersession
 *  fence already blocks the drain), and a source with no drafts answers
 *  exactly as before — no write, no publish, no result field. */
export async function withdrawClearedSourceQueuedMessages(
  ctx: AgentSessionTurnContext,
  input: { callerKey: string; operationId: string }
): Promise<AgentSessionWithdrawnQueuedMessage[]> {
  let withdrawn: AgentSessionWithdrawnQueuedMessage[]
  try {
    const messageIds = withdrawableQueuedMessages(ctx.journal).map((row) => row.messageId)
    if (messageIds.length === 0) {
      return []
    }
    withdrawn = await withdrawQueuedMessagesForOperation(ctx.journal, {
      sessionId: ctx.sessionId,
      messageIds,
      ...input
    })
  } catch {
    return []
  }
  if (withdrawn.length > 0) {
    // A failed publish must not drop bodies that were already withdrawn.
    try {
      ctx.publish()
    } catch {
      // The next journal commit carries the list.
    }
  }
  return withdrawn
}

/** A replay's answer, from the tombstones the original withdrawal stamped. */
export function replayWithdrawnQueuedMessages(
  journal: AgentSessionJournal,
  callerKey: string,
  operationId: string
): AgentSessionWithdrawnQueuedMessage[] {
  return journal.queuedMessages
    .receipts(agentSessionOperationKey(callerKey, operationId))
    .filter((row) => row.state === 'withdrawn')
    .map((row) => ({ messageId: row.messageId, body: row.body }))
}

function mutateQueued<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<TValue>
): Promise<AgentSessionMutationResult<TValue>> {
  return context.serialize(envelope.sessionId, () =>
    admitAndRunAgentSessionMutation({
      store: context.deps.store,
      adapter: context.deps.adapter,
      callerKey: caller.callerKey,
      envelope,
      plan,
      journal: () => context.sessions.get(envelope.sessionId)?.journal,
      prepareSession: openForWrite(context, envelope),
      publish: (journal) => context.publish(envelope.sessionId, journal),
      flushStreamedEvents: context.flushStreamedEvents,
      providerChildPhase: () => context.sessions.get(envelope.sessionId)?.child?.phase,
      now: () => context.now()
    })
  )
}

/**
 * Send-now. It overrides ONLY queue policy — FIFO order, pause, the busy-turn
 * wait — through the same send block and pending-prompt gates as any send;
 * supersession, Stop and prepared commands are never overridden. A returned
 * card re-consumes under a fresh submission id (this operation's id), recorded
 * as `consumed_as`, so one id still means one delivery.
 */
export function sendQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; messageId: string }
): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
  const { messageId } = params
  const operationId = params.envelope.clientOperationId
  const plan: MutationPlan<AgentSessionSendResult> = {
    method: 'agentSession.queuedMessageSend',
    fields: { messageId },
    conversationWrite: true,
    run: async (ctx): Promise<TurnOutcome<AgentSessionSendResult>> => {
      const blocked = structuredAgentSessionSendBlock(context.deps.store.getRecord(ctx.sessionId))
      if (blocked) {
        return blocked
      }
      const row = ctx.journal.queuedMessages.get(messageId)
      if (!row) {
        return invalid('No queued message by that id.')
      }
      if (row.state === 'withdrawn') {
        return invalid('This queued message was withdrawn.')
      }
      if (row.state === 'dispatched') {
        // Already a submission — answer with it rather than sending twice.
        const submission = submissionFor(ctx, row.consumedAs ?? row.messageId)
        return submission
          ? { ok: true, value: { clientMessageId: submission.clientMessageId, submission } }
          : invalid('This queued message was already sent.')
      }
      if (pendingPromptExists(ctx.journal.snapshot().items)) {
        return invalid('Answer the pending request before sending this message.')
      }
      const submissionId = row.state === 'returned' ? operationId : row.messageId
      try {
        await ctx.journal.appendSubmission(
          {
            clientMessageId: submissionId,
            payloadFingerprint: row.fingerprint,
            body: row.body,
            fence: ctx.fence,
            handoverRecorded: true
          },
          {
            messageId,
            expect: row.state,
            settledByOp: agentSessionOperationKey(ctx.resolvedBy, operationId)
          }
        )
      } catch (error) {
        if (error instanceof QueuedMessageNotConsumableError) {
          return invalid('The queued message changed underneath this Send; try again.')
        }
        throw error
      }
      releaseQueuedMessagePause(ctx.sessionId, messageId)
      context.wakeDelivery(ctx.sessionId)
      const submission = submissionFor(ctx, submissionId)
      if (!submission) {
        throw new Error('agent_session_submission_lost')
      }
      return { ok: true, value: { clientMessageId: submissionId, submission } }
    },
    replay: (ctx) => {
      const opKey = agentSessionOperationKey(ctx.resolvedBy, operationId)
      const row = ctx.journal.queuedMessages
        .receipts(opKey)
        .find((receipt) => receipt.messageId === messageId)
      if (!row || row.state !== 'dispatched') {
        return null
      }
      const submission = submissionFor(ctx, row.consumedAs ?? row.messageId)
      return submission ? { clientMessageId: submission.clientMessageId, submission } : null
    }
  }
  return mutateQueued(context, caller, params.envelope, plan)
}

/** Delete = discard, with the body in the receipt so the composer can restore it. */
export function deleteQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; messageId: string }
): Promise<AgentSessionMutationResult<AgentSessionQueuedMessageDeleteResult>> {
  const { messageId } = params
  const operationId = params.envelope.clientOperationId
  const plan: MutationPlan<AgentSessionQueuedMessageDeleteResult> = {
    method: 'agentSession.queuedMessageDelete',
    fields: { messageId },
    conversationWrite: true,
    run: async (ctx): Promise<TurnOutcome<AgentSessionQueuedMessageDeleteResult>> => {
      const row = ctx.journal.queuedMessages.get(messageId)
      if (!row) {
        return { ok: true, value: { deleted: false, messageId, disposition: 'missing' } }
      }
      if (row.state === 'dispatched') {
        return { ok: true, value: { deleted: false, messageId, disposition: 'dispatched' } }
      }
      if (row.state === 'withdrawn') {
        return { ok: true, value: { deleted: false, messageId, disposition: 'withdrawn' } }
      }
      const withdrawn = await withdrawQueuedMessagesForOperation(ctx.journal, {
        sessionId: ctx.sessionId,
        messageIds: [messageId],
        callerKey: ctx.resolvedBy,
        operationId
      })
      // A withdrawal writes no journal row; publish it, and re-derive the drain
      // — deleting a returned card can unblock the drafts behind it.
      ctx.publish()
      context.wakeQueuedDrain?.(ctx.sessionId)
      const body = withdrawn[0]?.body
      return body
        ? { ok: true, value: { deleted: true, messageId, body } }
        : { ok: true, value: { deleted: false, messageId, disposition: 'withdrawn' } }
    },
    replay: (ctx) => {
      const replayed = replayWithdrawnQueuedMessages(ctx.journal, ctx.resolvedBy, operationId).find(
        (entry) => entry.messageId === messageId
      )
      return replayed ? { deleted: true, messageId, body: replayed.body } : null
    }
  }
  return mutateQueued(context, caller, params.envelope, plan)
}
