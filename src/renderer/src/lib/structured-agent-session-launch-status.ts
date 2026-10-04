import { useMemo, useSyncExternalStore } from 'react'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  getStructuredAgentLaunchStatus,
  structuredLaunchStates,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'

/** One string per set, so the external-store snapshot stays stable between launches. */
function pendingStructuredAgentLaunchesKey(worktreeId: string): string {
  const agents = new Set<TuiAgent>()
  for (const state of structuredLaunchStates()) {
    if (state.intent.worktreeId === worktreeId) {
      agents.add(state.intent.agent)
    }
  }
  return [...agents]
    .filter((agent) => getStructuredAgentLaunchStatus(worktreeId, agent) === 'pending')
    .sort()
    .join('\n')
}

/** The agents whose chat is still starting in this worktree, whichever agents its host runs. */
export function useStructuredAgentLaunchPendingAgents(worktreeId: string): ReadonlySet<string> {
  const key = useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => pendingStructuredAgentLaunchesKey(worktreeId),
    () => ''
  )
  return useMemo(() => new Set(key ? key.split('\n') : []), [key])
}

/** Whether any agent's chat create in this worktree is still unsettled: pending or unanswered. */
export function hasStructuredAgentLaunchInWorktree(worktreeId: string): boolean {
  for (const state of structuredLaunchStates()) {
    if (state.intent.worktreeId === worktreeId) {
      return true
    }
  }
  return false
}
