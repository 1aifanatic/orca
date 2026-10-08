import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { runCommandReceiptMutation } from './structured-agent-session-command-receipt'

/** Only thrown while the provider dispatch is still unreachable. */
export class AgentSessionPreDispatchError extends Error {
  constructor(code: string) {
    super(code)
    this.name = 'AgentSessionPreDispatchError'
  }
}

export async function runSettledAgentSessionMutation<TValue>(input: {
  store: AgentSessionRecordStore
  operationCallerKey: string
  envelope: AgentSessionMutationEnvelope
  plan: MutationPlan<TValue>
  context: AgentSessionTurnContext
}): Promise<TurnOutcome<TValue>> {
  if (input.plan.settlesWithWrite) {
    return runCommandReceiptMutation(input)
  }
  const operation = {
    callerKey: input.operationCallerKey,
    operationId: input.envelope.clientOperationId
  }
  const settle = (
    outcome: Parameters<AgentSessionRecordStore['recordOperationOutcome']>[0]['outcome']
  ) => input.store.recordOperationOutcome({ ...operation, outcome })
  let outcome: TurnOutcome<TValue> | undefined
  try {
    outcome = await input.plan.run(input.context)
    await settle(
      outcome.ok
        ? (input.plan.settledOutcome?.(outcome.value) ?? {
            status: 'succeeded',
            sessionId: input.envelope.sessionId
          })
        : {
            status: 'failed',
            code: outcome.refusal.code,
            message: outcome.refusal.message,
            ...(outcome.refusal.details ? { details: outcome.refusal.details } : {}),
            // The row's own field, which builds before details read; copied from the legacy mirror.
            ...(outcome.refusal.rewindReason ? { rewindReason: outcome.refusal.rewindReason } : {})
          }
    )
    return outcome
  } catch (error) {
    const { logger, sessionId } = input.context
    try {
      await settle({ status: 'unknown' })
    } catch {
      // Bookkeeping must not replace the operation's proof of whether dispatch began.
      logger.warn('recording an operation as unknown failed', {
        scope: 'operation-unknown-settlement',
        sessionId,
        operationId: operation.operationId
      })
    }
    if (outcome && !outcome.ok) {
      logger.warn('recording a refused operation failed', {
        scope: 'operation-refused-settlement',
        sessionId,
        operationId: operation.operationId
      })
      return outcome
    }
    throw error
  }
}
