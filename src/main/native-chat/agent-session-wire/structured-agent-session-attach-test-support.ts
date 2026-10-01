// For a test that needs a running agent now: the attach an agent start makes, under the session's
// serialize, as the delivery loop runs it. A create starts nothing; its first message does.

import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { attachStructuredAgentSessionUnderSerialize } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'

export function attachForTests(
  host: StructuredAgentSessionHost,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { attachContext, serialize } = host.collaboratorsForTests()
  return serialize(params.envelope.sessionId, () =>
    attachStructuredAgentSessionUnderSerialize(attachContext(), caller.callerKey, params)
  )
}
