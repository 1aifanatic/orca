import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  OpenCodeSession,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'

export function observeOpenCodeExit(
  sessions: Map<string, OpenCodeSession>,
  session: OpenCodeSession,
  deps: OpenCodeStructuredSessionAdapterDeps
): void {
  if (sessions.get(session.sessionId) !== session || session.ended) {
    return
  }
  session.ended = true
  session.ready = false
  session.exitObservedAt = deps.now?.() ?? Date.now()
  session.streamAbort.abort()
  session.lane?.dispose()
  session.pending.clear()
  session.claims.clear()
  session.outstanding.clear()
  session.dispatchOrder.length = 0
  session.inputRecorded.clear()
  session.childActive.clear()
  try {
    deps.onChildWorkEvidence?.(session.sessionId, [
      { type: 'session-ended', observedAt: session.exitObservedAt }
    ])
  } catch (error) {
    deps.logger?.error('OpenCode child work settlement failed', {
      scope: 'opencode-child-work',
      sessionId: session.sessionId,
      error
    })
  }
  const reason = session.connection.process.stderrTail().trim() || 'OpenCode server exited'
  const event: StructuredAgentSessionEndedEvent = {
    type: 'ended',
    sessionId: session.sessionId,
    reason,
    failure: session.closing
      ? agentSessionFailureFact('hostFault')
      : agentSessionFailureFact('providerExited', {
          detail: providerDiagnosticOf(new Error(reason))
        }),
    cause: session.closing === 'requested-close' ? 'requested-close' : 'unexpected-exit',
    fence: session.fence,
    acquisitionGeneration: session.generation,
    observedAt: session.exitObservedAt,
    ...(!session.root ? { startupUnproven: true as const } : {})
  }
  try {
    deps.onEvent?.(event)
  } catch (error) {
    deps.logger?.error('OpenCode exit publication failed', {
      scope: 'opencode-exit',
      sessionId: session.sessionId,
      error
    })
  }
}

/** Every close path owns the same process, and keeps it indexed until first-hand root proof. */
export async function closeOpenCodeSession(
  sessions: Map<string, OpenCodeSession>,
  sessionId: string,
  deps: OpenCodeStructuredSessionAdapterDeps,
  requested: boolean
): Promise<boolean> {
  const session = sessions.get(sessionId)
  if (!session) {
    return true
  }
  session.closing = requested ? (session.closing ?? 'requested-close') : 'unexpected-exit'
  session.streamAbort.abort()
  const result = await session.connection.close()
  if (result.root !== 'exited') {
    return false
  }
  if (!session.ended) {
    observeOpenCodeExit(sessions, session, deps)
  }
  sessions.delete(sessionId)
  if (
    session.connection.process.rootExitObserved &&
    !session.connection.process.supervised &&
    result.tree !== 'exited'
  ) {
    throw new AgentSessionAcquisitionRootExitObservedError(
      new Error('OpenCode root exited; descendant tree is unproven')
    )
  }
  return true
}

export async function closeAllOpenCodeSessions(
  sessions: Map<string, OpenCodeSession>,
  close: (sessionId: string) => Promise<boolean>
): Promise<void> {
  const rootOnly: AgentSessionAcquisitionRootExitObservedError[] = []
  await closeProcessRegistry({
    attempts: 3,
    hasEntries: () => sessions.size > 0,
    entryIds: () => sessions.keys(),
    closeEntry: async (sessionId) => {
      try {
        return await close(sessionId)
      } catch (error) {
        if (error instanceof AgentSessionAcquisitionRootExitObservedError) {
          rootOnly.push(error)
          return true
        }
        throw error
      }
    },
    failureMessage: 'OpenCode structured session shutdown could not prove every server stopped'
  })
  if (rootOnly.length > 0) {
    throw new AggregateError(rootOnly, 'OpenCode roots exited but descendant cleanup is unproven')
  }
}
