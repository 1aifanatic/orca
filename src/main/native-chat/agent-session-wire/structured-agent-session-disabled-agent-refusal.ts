import { AgentDisabledLaunchError } from '../../../shared/agent-disabled-launch-refusal'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** The one rule for a turned-off agent on the chat host: only a session with no record is new and
 *  refused; an existing chat, including a committed create's replay, keeps starting its agent. */
export function structuredAgentSessionDisabledAgentRefusal(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'isAgentEnabled'>,
  sessionId: string,
  agent: AgentSessionRecord['provider']
): AgentDisabledLaunchError | null {
  if (deps.isAgentEnabled?.(agent) !== false || deps.store.getRecord(sessionId)) {
    return null
  }
  return new AgentDisabledLaunchError(agent)
}
