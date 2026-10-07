// A send whose child no longer matches the chat's launch options gets a new child first.
//
// Claude only takes Full access at launch, so a chat moved to it mid-session keeps a child that
// cannot honour it. Before the next send, an idle child is put to rest the way the idle sweep
// does it — silently, nothing the chat records — and the send starts one that resumes the
// conversation under the new launch. A child still owing work keeps running: the send steers into
// it under the old mode, and the next send after it finishes relaunches.

import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { hasPendingStructuredAgentSessionPrompt } from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export async function relaunchOutgrownStructuredAgentSessionChild(
  input: {
    session: StructuredAgentSessionHostSession | undefined
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
