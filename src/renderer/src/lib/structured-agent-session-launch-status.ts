import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { structuredLaunchesHoldingIdentity } from './structured-agent-session-launch-holders'
import { isStructuredLaunchAwaitingHost } from './structured-agent-session-launch-awaiting-host'
import {
  structuredLaunchIdentity,
  type StructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'

/** Whether a chat for this pair is being created here: its own first create, or an adoption, or a
 *  launch still waiting on its host's answer. */
export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  if (isStructuredLaunchAwaitingHost(worktreeId, agent)) {
    return 'pending'
  }
  // Any launch holding an identity for this pair, adopted conversations included, is starting here.
  // A failed chat is not, nor an unconfirmed or retried blank one: a new launch opens its own chat.
  const identity = structuredLaunchIdentity(worktreeId, agent)
  const states = structuredLaunchesHoldingIdentity(
    (candidate) => candidate === identity || candidate.startsWith(`${identity}:resume:`)
  )
  if (states.length === 0) {
    return 'idle'
  }
  return states.some((state) => state.visibilityUnknown) ? 'unknown' : 'pending'
}
