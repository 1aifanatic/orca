// A conversation command's hold on the session's lane, as the sends and Stops
// that arrive while it runs see it.

import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

export function conversationOperationWaitRefusal(): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return {
    ok: false,
    refusal: refuse(
      'agent_session_operation_invalid',
      { reason: 'conversationCommandInFlight' },
      'Wait for the conversation operation to finish.'
    )
  }
}

/** While a /compact awaits its terminal frame it holds the session's lane; a
 *  Stop, and a send that the queue gate holds behind it, run on this one. Null
 *  when no compact is in flight. */
export function compactInFlightContext(
  context: StructuredAgentSessionMutationContext,
  sessionId: string
): StructuredAgentSessionMutationContext | null {
  const command = context.deps.store.getRecord(sessionId)?.conversationCommand
  return command?.command === 'compact' && command.phase === 'prepared'
    ? {
        ...context,
        serialize: <T>(laneSessionId: string, task: () => Promise<T>) =>
          context.serialize(`compact-cancel:${laneSessionId}`, task)
      }
    : null
}
