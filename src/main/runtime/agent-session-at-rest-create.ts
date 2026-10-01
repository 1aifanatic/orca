// A chat's creation: its record at rest and the operation row that answers a retry of it, in one
// write. Nothing starts here; the chat's first message starts its agent, as /clear's new chat does.

import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { isAgentSessionOptions, type AgentSessionRecord } from '../../shared/agent-session-record'
import { isAgentSessionLaunchArgs } from '../../shared/agent-session-launch-args'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { foundAgentSessionRecord } from './agent-session-record-founding'
import {
  assertAdoptedConversationUnowned,
  assertReservedTabUnheld,
  evaluateAgentSessionReserveOperation,
  requireAgentSessionRecordForReplay,
  type AgentSessionReserveRequest
} from './agent-session-reservation-admission'

export type AgentSessionAtRestCreateRequest = Pick<
  AgentSessionReserveRequest,
  | 'sessionId'
  | 'location'
  | 'provider'
  | 'accountHome'
  | 'launchArgs'
  | 'options'
  | 'surfaceTabId'
  | 'adoptedHandleLink'
  | 'claimKeyId'
  | 'operation'
  | 'now'
>

export type AgentSessionAtRestCreateResult = {
  record: AgentSessionRecord
  /** The row a replay answers from; a fresh create's is already settled as succeeded. */
  operationRow: AgentSessionOperationRow
  replayed: boolean
}

export function commitAgentSessionAtRestCreate(
  state: AgentSessionStoreState,
  request: AgentSessionAtRestCreateRequest
): AgentSessionAtRestCreateResult {
  const decision = evaluateAgentSessionReserveOperation(state, request)
  if (decision.decision === 'refused') {
    throw agentSessionRefusalError(decision.code, decision.details)
  }
  if (decision.decision === 'replay') {
    return {
      record: requireAgentSessionRecordForReplay(state, decision.row, request.sessionId),
      operationRow: decision.row,
      replayed: true
    }
  }
  if (request.launchArgs && !isAgentSessionLaunchArgs(request.launchArgs)) {
    throw new Error('agent_session_launch_args_invalid')
  }
  if (request.options && !isAgentSessionOptions(request.options)) {
    throw new Error('agent_session_options_invalid')
  }
  if (state.unreadableRecords.has(request.sessionId)) {
    throw agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
  }
  if (state.records.has(request.sessionId)) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'sessionExists' })
  }
  assertAdoptedConversationUnowned(state, request)
  assertReservedTabUnheld(state, request)
  const record = foundAgentSessionRecord(request, request, request.adoptedHandleLink)
  const operationRow: AgentSessionOperationRow = {
    ...pendingAgentSessionOperationRow({ ...request.operation, now: request.now }),
    outcome: { status: 'succeeded', sessionId: request.sessionId }
  }
  state.records.set(record.sessionId, record)
  state.operations.set(
    agentSessionOperationKey(operationRow.callerKey, operationRow.operationId),
    operationRow
  )
  return { record, operationRow, replayed: false }
}
