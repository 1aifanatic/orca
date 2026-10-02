import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  getStructuredLaunchState,
  launchStateLifecycle,
  structuredLaunchIdentity,
  structuredLaunchStates,
  subscribeStructuredAgentLaunchStatus,
  type StructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  // Any launch for this pair, including adopted conversations, means a chat is starting here.
  const states = [
    getStructuredLaunchState(structuredLaunchIdentity(worktreeId, agent)),
    ...[...structuredLaunchStates()].filter((state) =>
      state.identity.startsWith(`${agent}:${worktreeId}:resume:`)
    )
  ].filter((state): state is StructuredLaunchState => Boolean(state))
  if (states.length === 0) {
    return 'idle'
  }
  if (states.some((state) => state.visibilityUnknown)) {
    return 'unknown'
  }
  // A failed launch stays registered for its Retry but is not starting; launching the agent retries it.
  return states.every((state) => launchStateLifecycle(state) === 'failed') ? 'failed' : 'pending'
}

export function useStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentLaunchStatus(worktreeId, agent),
    () => 'idle'
  )
}
