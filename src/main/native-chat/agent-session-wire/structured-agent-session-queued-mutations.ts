// `agentSession.queuedMessageSend` / `agentSession.queuedMessageDelete`, and
// /clear's carry of the source's drafts to its replacement session. Settling
// operations stamp op-scoped tombstone receipts, so a lost acknowledgement
// replays from the rows themselves — never from the operation ledger, which
// records only that an operation happened. No mutation returns draft text:
// the published list is the one authority a client renders.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/journal-queued-messages'
import {
  queuedMessageNeedsFreshSubmissionId,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import {
  queuedMessageFingerprint,
  structuredQueueHold
} from './structured-agent-session-queued-messages'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import { awaitUserSendTurn, unsettledQueuedMessages } from './structured-agent-session-queued-stop'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  openForWrite,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
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

/** One transaction, stamped with the operation's caller-scoped key so a replay
 *  answers "spent" from the receipts. Withdrawal retires any hold in the same
 *  UPDATE, and the store's commit notification publishes the change. */
export async function withdrawQueuedMessagesForOperation(
  journal: AgentSessionJournal,
  input: {
    sessionId: string
    messageIds: readonly string[]
    callerKey: string
    operationId: string
  }
): Promise<QueuedMessageRow[]> {
  return journal.queuedMessages.withdraw({
    messageIds: input.messageIds,
    settledByOp: agentSessionOperationKey(input.callerKey, input.operationId)
  })
}

/**
 * /clear's carry: the source's unsettled drafts become held rows on the
 * replacement session — the SAME for every client version, with no text on the
 * wire — so the cards stay visible where the user now is. Runs after the
 * replacement's attach succeeded and before the clear commits. Each insert is
 * idempotent on (session, message), so the clear's rerun-while-prepared replays
 * it safely; the source rows are then tombstoned. Bookkeeping around the clear:
 * a failure leaves the cards on the superseded source — whose supersession
 * fence already blocks the drain — reported, never gating the clear. A crash
 * between the copy and the tombstone leaves both, which the fence also makes
 * harmless: nothing is lost and nothing runs.
 */
export async function carryQueuedMessagesToClearReplacement(
  ctx: AgentSessionTurnContext,
  input: {
    replacementSessionId: string
    replacementJournal: AgentSessionJournal | undefined
    callerKey: string
    operationId: string
  }
): Promise<void> {
  try {
    const rows = unsettledQueuedMessages(ctx.journal)
    if (rows.length === 0) {
      return
    }
    const replacement = input.replacementJournal
    if (!replacement) {
      throw new Error('the replacement journal is not open')
    }
    for (const row of rows) {
      // Held from birth ('stopped', the Stop-pause lifetime): the replacement is
      // idle, so an unheld insert would drain before the hold could land. A
      // returned card carries over as a plain held draft — its refusal belonged
      // to the source's submissions. The fingerprint is re-scoped to the
      // replacement, or its echo could never alias the sent bubble.
      await replacement.queuedMessages.insert({
        messageId: row.messageId,
        body: row.body,
        fingerprint: queuedMessageFingerprint(input.replacementSessionId, row.body),
        hostInstance: structuredAgentSessionHostInstance(),
        holdReason: 'stopped'
      })
    }
    await withdrawQueuedMessagesForOperation(ctx.journal, {
      sessionId: ctx.sessionId,
      messageIds: rows.map((row) => row.messageId),
      callerKey: input.callerKey,
      operationId: input.operationId
    })
  } catch (error) {
    console.warn("[agent-session] /clear's queued-draft carry skipped:", {
      sessionId: ctx.sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
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
 * supersession, Stop and prepared commands are never overridden. A draft whose
 * own id is spent — a returned card, or one a withdrawal sent back to waiting —
 * re-consumes under a fresh submission id (this operation's id), recorded as
 * `consumed_as`, so one id still means one delivery.
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
      // The one queue gate; Send-now's override set is exactly `working` (plus
      // FIFO order and the stored hold, which the consume below clears).
      const record = context.deps.store.getRecord(ctx.sessionId)
      const hold = structuredQueueHold({ journal: ctx.journal, record, fence: ctx.fence })
      if (hold === 'blocked') {
        return structuredAgentSessionSendBlock(record) ?? invalid('This conversation cannot send.')
      }
      if (hold === 'command') {
        return invalid('Wait for the conversation operation to finish.')
      }
      if (hold === 'prompt') {
        return invalid('Answer the pending request before sending this message.')
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
      const submissionId = queuedMessageNeedsFreshSubmissionId(row) ? operationId : row.messageId
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
      const submission = submissionFor(ctx, submissionId)
      if (!submission) {
        throw new Error('agent_session_submission_lost')
      }
      awaitUserSendTurn(context.sessions.get(ctx.sessionId), submission)
      context.wakeDelivery(ctx.sessionId)
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

/** Delete = discard, with no body in the answer: the card leaving the published
 *  list IS the outcome, so a lost answer needs no re-ask. An Edit is the client
 *  copying the text it already renders, then this Delete. */
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
      // The withdrawal notifies through the journal's commit listener, which
      // also re-derives the drain — deleting a returned card can unblock the
      // drafts behind it.
      const withdrawn = await withdrawQueuedMessagesForOperation(ctx.journal, {
        sessionId: ctx.sessionId,
        messageIds: [messageId],
        callerKey: ctx.resolvedBy,
        operationId
      })
      return withdrawn.length > 0
        ? { ok: true, value: { deleted: true, messageId } }
        : { ok: true, value: { deleted: false, messageId, disposition: 'withdrawn' } }
    },
    replay: (ctx) => {
      const replayed = ctx.journal.queuedMessages
        .receipts(agentSessionOperationKey(ctx.resolvedBy, operationId))
        .some((row) => row.messageId === messageId && row.state === 'withdrawn')
      return replayed ? { deleted: true, messageId } : null
    }
  }
  return mutateQueued(context, caller, params.envelope, plan)
}
