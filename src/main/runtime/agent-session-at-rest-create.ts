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
import { isAgentSessionSurfaceTabId } from '../../shared/agent-session-surface-tab-id'
import {
  agentSessionProviderHandleRoot,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import {
  foundAgentSessionRecord,
  type AgentSessionRecordIdentity
} from './agent-session-record-founding'
import {
  evaluateAgentSessionReserveOperation,
  requireAgentSessionRecordForReplay,
  type AgentSessionReserveRequest
} from './agent-session-reservation-admission'

export type AgentSessionAtRestCreateRequest = AgentSessionRecordIdentity &
  Pick<AgentSessionReserveRequest, 'claimKeyId' | 'operation' | 'now'> & {
    /** The tab id a create reserves for this conversation, taken when its tab is published. */
    surfaceTabId?: string
    /** The provider conversation this create adopts; its first start resumes it. */
    adoptedHandleLink?: AgentSessionProviderHandleLink
  }

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

/**
 * Refuse an adoption whose conversation ANOTHER record already holds.
 *
 * It runs inside the store transaction because the pre-commit check in the RPC resolver cannot be
 * the guard: two concurrent adoptions of one conversation mint different session ids, so neither
 * sees the other's record and both would pass. Codex permits two app-servers on one thread
 * silently, so the cost of missing this is a corrupted conversation rather than an error.
 */
function assertAdoptedConversationUnowned(
  state: AgentSessionStoreState,
  request: Pick<AgentSessionAtRestCreateRequest, 'sessionId' | 'adoptedHandleLink'>
): void {
  const adopted = request.adoptedHandleLink
  if (!adopted) {
    return
  }
  const root = agentSessionProviderHandleRoot(adopted.handle)
  for (const record of state.records.values()) {
    if (record.sessionId === request.sessionId) {
      continue
    }
    const holdsSameConversation = record.providerHandleChain.some(
      (link) => agentSessionProviderHandleRoot(link.handle) === root
    )
    if (holdsSameConversation) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere'
      })
    }
  }
}

/**
 * A tab id names one conversation, so a reserved id another session's tab holds is a conflict.
 * Checked, not claimed: the id is taken when the chat's tab is published, so a create that never
 * gets that far leaves nothing in the table to restore or release.
 */
function assertReservedTabUnheld(
  state: AgentSessionStoreState,
  request: Pick<AgentSessionAtRestCreateRequest, 'sessionId' | 'surfaceTabId'>
): void {
  if (request.surfaceTabId === undefined) {
    return
  }
  if (!isAgentSessionSurfaceTabId(request.surfaceTabId)) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const holder = state.sessionTabs?.sessionIdFor(request.surfaceTabId)
  if (holder !== undefined && holder !== request.sessionId) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'tabIdTaken' })
  }
}
