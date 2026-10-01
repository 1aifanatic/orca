// A new chat whose agent could not start, with nothing of that start left running, is created at
// rest: its record and tab stand, as after /clear, and its first message starts the agent and
// carries why it could not, as any message does. Only a start that left a process unproven, or a
// host with nothing to run the chat from, still refuses the create.

import { agentSessionLeaseIsReleased } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { startFailureKeepsChat } from '../../../shared/agent-session-start-resumability'
import type { AgentSessionReserveResult } from '../../runtime/agent-session-reservation-admission'
import { withAgentSessionCreatePhase } from '../../observability/agent-session-instrumentation'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import {
  failedAcquisitionCode,
  failedAcquisitionSettlement,
  type FailedAcquisitionWording
} from './structured-agent-session-failed-create-refusal'

/**
 * Settles a failed start of the reservation this attach made, with its operation, in one
 * transaction. Returns the chat's record when it stands at rest, its create answered; null when the
 * failure answers the attach.
 */
export async function settleFailedStartOfReservation(
  input: AttachFlowInput,
  error: unknown,
  reservation: { fence: number; spawnToken: string },
  wording: FailedAcquisitionWording
): Promise<AgentSessionRecord | null> {
  const { sessionId } = input.params.envelope
  const settlement = failedAcquisitionSettlement(error, wording)
  const atRest =
    input.params.envelope.expectedRuntimeFence === null &&
    settlement.exitProof !== 'unproven' &&
    startFailureKeepsChat(failedAcquisitionCode(error))
  try {
    const settle = () =>
      input.store.settleFailedAcquisition({
        sessionId,
        ...reservation,
        callerKey: input.callerKey,
        operationId: input.params.envelope.clientOperationId,
        exitProof: settlement.exitProof,
        outcome: atRest ? { status: 'succeeded', sessionId } : settlement.outcome,
        now: input.now()
      })
    // Its own phase, so a create that deferred its start still counts as one whose start failed.
    const settled = atRest
      ? await withAgentSessionCreatePhase('start_deferred', input.recordPhase, settle)
      : await settle()
    return atRest ? settled : null
  } catch (settlementError) {
    throw new AggregateError(
      [error, settlementError],
      'agent session acquisition failure settlement failed'
    )
  }
}

/** A create replayed after it left its chat at rest answers again, and starts nothing. */
export function isReplayedCreateAtRest(
  input: Pick<AttachFlowInput, 'params'>,
  reserved: AgentSessionReserveResult
): boolean {
  return (
    input.params.envelope.expectedRuntimeFence === null &&
    reserved.disposition === 'replayed' &&
    reserved.operationRow.outcome.status === 'succeeded' &&
    agentSessionLeaseIsReleased(reserved.record.lease)
  )
}
