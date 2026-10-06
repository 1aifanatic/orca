import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrcaSessionId } from '../../../../../../shared/orca-session-address'
import {
  chatAssigneeSessionId,
  observeChatAssignee,
  type ChatAssigneeObservation
} from '../../../../orchestration/chat-assignee'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { structuredWorkerAddressable } from '../../../../structured-worker-custody'
import {
  observeStructuredWorker,
  resolveStructuredWorkerForDispatch
} from '../../orchestration-structured-worker-lifecycle'

export type SessionWorkerObservation = {
  terminal: null
  exact: boolean
  status: 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  reason?: string
  addressable?: boolean
  terminalHandle: null
}

/**
 * A worker that is an agent session, a structured worker or a chat, observed off the session
 * records instead of a terminal; null for a PTY worker.
 */
export async function inspectSessionWorker(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  dispatchId: string,
  terminalHandle: string
): Promise<SessionWorkerObservation | null> {
  const chat = chatAssigneeSessionId(terminalHandle)
  if (chat) {
    // The address is the chat's whole identity, so it is always exact. After a restart nothing
    // has installed the host yet, and its records are what this reads.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    const observed = observeChatAssignee(chat, db)
    return {
      terminal: null,
      exact: true,
      status: observed.status,
      ...(observed.status === 'unverifiable' ? { reason: observed.reason } : {}),
      terminalHandle: null
    }
  }
  const structured = resolveStructuredWorkerForDispatch(db, dispatchId)
  if (!structured) {
    return null
  }
  // Exactness is the recorded pane and lineage, which the runtime getters answer from the
  // structured registry; there is no terminal to show.
  //
  // `agentWait` is deliberately ABSENT rather than null. Null is the contract's "Orca looked and
  // found no wait", and nothing here looks: a structured worker parks on a journal question item,
  // which no terminal prompt scan can see. Reporting null would tell a coordinator the worker is
  // not waiting, which is the one thing the field's own documentation forbids inferring.
  const exact = db.isDispatchProcessCurrent({
    dispatchId,
    paneKey: structured.paneKey,
    processIncarnation: structured.processIncarnation
  })
  const observation = observeStructuredWorker(structured)
  const addressable = structuredWorkerAddressable(
    db,
    structured.sessionId,
    db.getWorkerTerminalResourceByHandle?.(structured.handle)
  )
  return {
    terminal: null,
    exact,
    status: exact ? observation.status : 'identity_changed',
    ...(exact && observation.reason ? { reason: observation.reason } : {}),
    ...(exact && addressable !== null ? { addressable } : {}),
    terminalHandle: null
  }
}

/** A fleet page's chat verdicts, read off the session records a restart leaves uninstalled. */
export async function chatAssigneeObserver(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  rows: readonly { agentTerminalHandle: string | null }[]
): Promise<(sessionId: OrcaSessionId) => ChatAssigneeObservation> {
  if (rows.some((row) => chatAssigneeSessionId(row.agentTerminalHandle))) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
  return (sessionId) => observeChatAssignee(sessionId, db)
}
