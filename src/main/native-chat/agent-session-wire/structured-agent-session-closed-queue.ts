import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop'

/** A close of this chat that stopped its child and then did not complete still closed what was
 *  queued before it, so no child starts for those. Ordered, not latched: a later send goes on.
 *  False when those could not be closed. */
export async function closeWhatTheUserClosed(
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  abandonQueued: StructuredAgentSessionDeliveryLoopDeps['abandonQueued']
): Promise<boolean> {
  const ended = session.lastEndedChild
  if (session.child || ended?.cause !== 'user-close') {
    return true
  }
  const { epoch } = session.journal.cursor()
  return abandonQueued(
    sessionId,
    (submission) =>
      ended.endedAt.epoch === epoch &&
      submission.acceptedSequence !== undefined &&
      submission.acceptedSequence <= ended.endedAt.sequence
  )
}
