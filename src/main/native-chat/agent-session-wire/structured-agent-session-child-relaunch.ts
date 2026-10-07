import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
// An idle child that cannot run the chat's new mode resumes with the required launch flag.
import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { hasPendingStructuredAgentSessionPrompt } from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentChildRelaunchSession = Pick<
  StructuredAgentSessionHostSession,
  'child'
> & {
  journal: {
    activeTurnId: () => string | null
    snapshot: () => { items: readonly AgentJournalRenderItem[] }
  }
}

export async function relaunchOutgrownStructuredAgentSessionChild(
  input: {
    session: StructuredAgentChildRelaunchSession | undefined
    adapter: Pick<StructuredAgentSessionAdapter, 'childRelaunchRequired' | 'holdsDispatch'>
    childWork: readonly AgentChildWorkView[] | undefined
    /** Puts the child to rest; inside the caller's serialize. */
    restChild: () => Promise<void>
    logger: StructuredAgentSessionLogger
  },
  sessionId: string
): Promise<void> {
  const { session, adapter } = input
  const child = session?.child
  if (!session || !child || child.phase !== 'ready' || child.close) {
    return
  }
  if (!adapter.childRelaunchRequired?.(sessionId)) {
    return
  }
  if (
    session.journal.activeTurnId() !== null ||
    adapter.holdsDispatch?.(sessionId) === true ||
    agentChildWorkLiveness(input.childWork) !== null ||
    hasPendingStructuredAgentSessionPrompt(session.journal.snapshot().items)
  ) {
    return
  }
  try {
    await input.restChild()
  } catch (error) {
    // The send still goes: a child that would not stop keeps serving it under the old launch.
    input.logger.warn('relaunching a child for its new launch options failed', {
      scope: 'child-relaunch',
      sessionId,
      error
    })
  }
}
