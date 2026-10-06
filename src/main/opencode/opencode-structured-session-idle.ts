import type {
  OpenCodeSession,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'

export function settleOpenCodeIdleDispatches(
  session: OpenCodeSession,
  deps: OpenCodeStructuredSessionAdapterDeps,
  rootIdleObserved = false
): void {
  if (
    !session.ready ||
    session.ended ||
    !session.root ||
    !session.translator ||
    session.translator.turns.has(session.root.id) ||
    session.childActive.size > 0 ||
    session.pending.size > 0 ||
    (!rootIdleObserved && session.outstanding.size === 0)
  ) {
    return
  }
  try {
    deps.onPrimaryThreadStoppedRunning?.({ sessionId: session.sessionId })
  } catch (error) {
    deps.logger?.error('OpenCode idle dispatch settlement failed', {
      scope: 'opencode-root-idle',
      sessionId: session.sessionId,
      error
    })
  }
  // An idle boundary cannot disprove a newer write; retain its native receipt correlation.
}
