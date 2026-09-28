// `agentSession.queuedMessageSend` / `agentSession.queuedMessageDelete`, and the
// withdraw step Stop and /clear share. All three settle drafts into op-stamped
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
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  openForWrite,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import {
  pauseQueuedMessage,
  releaseQueuedMessagePause
} from './structured-agent-session-queued-pause'
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

function pendingPromptBlocks(ctx: AgentSessionTurnContext): boolean {
  return ctx.journal
    .snapshot()
    .items.some(
      (item) =>
        (item.body.kind === 'approval' || item.body.kind === 'question') &&
        item.body.resolution.state === 'pending'
    )
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

/** Stop step (1): pause the withdrawable frontier at the serialized stop step —
 *  sends accepted after it are new work. Bookkeeping never gates the Stop. */
export function pauseWithdrawableQueuedMessages(
  journal: AgentSessionJournal,
  sessionId: string
): QueuedMessageRow[] {
  try {
    const frontier = withdrawableQueuedMessages(journal)
    for (const row of frontier) {
      pauseQueuedMessage(sessionId, row.messageId)
    }
    return frontier
  } catch {
    return []
  }
}

/** Stop step (3): compare-and-transition the frontier, one transaction stamped
 *  with the Stop's caller-scoped key, returning the bodies — returned cards'
 *  text included. Failure leaves the drafts paused and visible; the Stop itself
 *  still succeeded, so nothing here may throw. */
export async function settleStopQueuedWithdrawal(
  ctx: AgentSessionTurnContext,
  input: {
    operationId: string
    frontier: readonly QueuedMessageRow[]
    wake?: ((sessionId: string) => void) | undefined
  }
): Promise<{ withdrawnQueued: AgentSessionWithdrawnQueuedMessage[] } | Record<string, never>> {
  try {
    const withdrawnQueued = await withdrawQueuedMessagesForOperation(ctx.journal, {
      sessionId: ctx.sessionId,
      messageIds: input.frontier.map((row) => row.messageId),
      callerKey: ctx.resolvedBy,
      operationId: input.operationId
    })
    ctx.publish()
    input.wake?.(ctx.sessionId)
    return { withdrawnQueued }
  } catch {
    return {}
  }
}

/**
 * The two Stop steps around the interrupt, packaged for the cancel path: pause
 * the withdrawable frontier NOW (the drain must not send a draft the user is
 * stopping), and hand back the finisher that withdraws it after the interrupt —
 * only when the capable client asked (`withdrawQueued`); an old-client Stop is
 * pause + interrupt alone.
 */
export function stopQueuedWithdrawalFinisher(
  ctx: AgentSessionTurnContext,
  input: {
    withdrawQueued: true | undefined
    operationId: string
    wake?: ((sessionId: string) => void) | undefined
  }
): <TValue extends object>(value: TValue) => Promise<{ ok: true; value: TValue }> {
  const frontier = pauseWithdrawableQueuedMessages(ctx.journal, ctx.sessionId)
  return async (value) =>
    input.withdrawQueued
      ? {
          ok: true,
          value: {
            ...value,
            ...(await settleStopQueuedWithdrawal(ctx, {
              operationId: input.operationId,
              frontier,
              wake: input.wake
            }))
          }
        }
      : { ok: true, value }
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
      if (pendingPromptBlocks(ctx)) {
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
