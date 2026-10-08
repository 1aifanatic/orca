import type { AgentSessionOperationRow } from './agent-session-operation-ledger'

export const AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT = 4_096
export const AGENT_SESSION_DURABLE_OPERATION_PER_CLIENT_LIMIT = 512
export const AGENT_SESSION_CONTROL_OPERATION_GLOBAL_LIMIT = 512
export const AGENT_SESSION_CONTROL_OPERATION_PER_CLIENT_LIMIT = 64

export function agentSessionWorkOperationAtCapacity(
  rows: ReadonlyMap<string, AgentSessionOperationRow>,
  callerKey: string
): boolean {
  let total = 0
  let caller = 0
  for (const row of rows.values()) {
    if (row.control) {
      continue
    }
    total += 1
    if (row.callerKey === callerKey) {
      caller += 1
    }
  }
  return (
    total >= AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT ||
    caller >= AGENT_SESSION_DURABLE_OPERATION_PER_CLIENT_LIMIT
  )
}

/** Control history may be lost under pressure; delivery receipts must survive their retry window. */
export function makeAgentSessionControlOperationRoom(
  rows: Map<string, AgentSessionOperationRow>,
  callerKey: string
): boolean {
  const controls = [...rows].filter(([, row]) => row.control)
  const callerRows = controls.filter(([, row]) => row.callerKey === callerKey)
  const candidates =
    callerRows.length >= AGENT_SESSION_CONTROL_OPERATION_PER_CLIENT_LIMIT ? callerRows : controls
  if (
    callerRows.length < AGENT_SESSION_CONTROL_OPERATION_PER_CLIENT_LIMIT &&
    controls.length < AGENT_SESSION_CONTROL_OPERATION_GLOBAL_LIMIT
  ) {
    return true
  }
  const oldest = candidates
    .filter(([, row]) => row.outcome.status === 'succeeded' || row.outcome.status === 'failed')
    .sort(([, left], [, right]) => left.recordedAt - right.recordedAt)[0]
  if (!oldest) {
    return false
  }
  rows.delete(oldest[0])
  return true
}
