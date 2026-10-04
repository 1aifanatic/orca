import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  structuredLaunchesHoldingIdentity,
  structuredLaunchIdentity,
  subscribeStructuredAgentLaunchStatus,
  type StructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'
import type { StructuredLaunchRequest } from './structured-agent-session-launch-request'

/** With `request`, only the launches a start of it would join: a different request opens its own. */
export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  request?: StructuredLaunchRequest
): StructuredAgentLaunchStatus {
  // Any launch holding an identity for this pair, adopted conversations included, is starting here.
  // A failed chat is not, nor an unconfirmed or retried blank one: a new launch opens its own chat.
  const identity = structuredLaunchIdentity(worktreeId, agent)
  const states = structuredLaunchesHoldingIdentity(
    (candidate) => candidate === identity || candidate.startsWith(`${identity}:resume:`),
    request
  )
  if (states.length === 0) {
    return 'idle'
  }
  return states.some((state) => state.visibilityUnknown) ? 'unknown' : 'pending'
}

export function useStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  request?: StructuredLaunchRequest
): StructuredAgentLaunchStatus {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentLaunchStatus(worktreeId, agent, request),
    () => 'idle'
  )
}
