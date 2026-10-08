import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionSendResult,
  AgentSessionMutationEnvelope
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { commandReceiptScope } from '../agent-session-journal/command-receipt-schema'
import { buildCommandReceiptTransaction } from '../agent-session-journal/command-receipt-transaction'
import { journalSubmissionFromRow } from '../agent-session-journal/journal-submission-fold'
import { composeJournalOperationReceipts } from '../agent-session-journal/journal-row-writer'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'

/** Acceptance identity and compatibility bookkeeping share the submission or draft's commit. */
export async function runCommandReceiptMutation<TValue>(input: {
  store: AgentSessionRecordStore
  operationCallerKey: string
  envelope: AgentSessionMutationEnvelope
  plan: MutationPlan<TValue>
  context: AgentSessionTurnContext
}): Promise<TurnOutcome<TValue>> {
  const { store, operationCallerKey, envelope, plan, context } = input
  const fingerprint = computeAgentSessionPayloadFingerprint({
    method: plan.method,
    sessionId: envelope.sessionId,
    fields: plan.fields
  })
  const outcome = { status: 'succeeded' as const, sessionId: envelope.sessionId }
  let acceptedSend: AgentSessionSendResult | undefined
  const receipt = composeJournalOperationReceipts(
    buildCommandReceiptTransaction(
      commandReceiptScope(operationCallerKey, plan.operationIdScope),
      (row) => {
        if (row) {
          if (row.kind !== 'submission') {
            throw new Error('Send acceptance requires a submission')
          }
          acceptedSend = {
            clientMessageId: envelope.clientOperationId,
            submission: journalSubmissionFromRow(row)
          }
        } else {
          const draft = context.journal.queuedMessages.get(envelope.clientOperationId)
          if (!draft) {
            throw new Error('queued Send acceptance requires a draft')
          }
          acceptedSend = {
            clientMessageId: envelope.clientOperationId,
            queued: { messageId: draft.messageId, position: draft.position, state: draft.state }
          }
        }
        return {
          operationId: envelope.clientOperationId,
          sessionId: envelope.sessionId,
          callerKey: operationCallerKey,
          method: plan.method,
          fingerprint,
          status: 'accepted',
          acceptedAt: context.now(),
          result: row
            ? { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
            : { kind: 'queued-draft', messageId: envelope.clientOperationId }
        }
      }
    ),
    store.operationOutcomeReceipt({
      callerKey: operationCallerKey,
      operationId: envelope.clientOperationId,
      fingerprint,
      now: context.now(),
      ...(plan.operationIdScope ? { operationIdScope: plan.operationIdScope } : {}),
      outcome
    })
  )
  let committed = false
  try {
    const ran = await plan.run({
      ...context,
      operationReceipt: {
        write: receipt.write,
        committed: () => {
          committed = true
          receipt.committed()
        }
      }
    })
    if (!committed || ran.ok) {
      return ran
    }
  } catch (error) {
    if (!committed) {
      throw error
    }
  }
  context.logger.warn('publishing an accepted command failed; answering its committed result', {
    scope: 'command-receipt-publication',
    sessionId: envelope.sessionId,
    operationId: envelope.clientOperationId
  })
  await context.journal.refreshCommittedState().catch((error: unknown) => {
    context.logger.warn('reloading an accepted command failed', {
      scope: 'command-receipt-reload',
      sessionId: envelope.sessionId,
      error
    })
  })
  const replay = resolveAgentSessionReplayOutcome({
    operationId: envelope.clientOperationId,
    outcome,
    reconstruct: () => plan.replay(context, outcome, acceptedSend),
    recoverUnknownFromDurableState: plan.recoverUnknownFromDurableState
  })
  return replay.decision === 'replay'
    ? { ok: true, value: replay.value }
    : { ok: false, refusal: replay.decision === 'refuse' ? replay.refusal : unreachableReplay() }
}

function unreachableReplay(): never {
  throw new Error('an accepted command cannot run again')
}
