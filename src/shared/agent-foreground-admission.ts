import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isSameAgentProcess, type AgentProcessPresence } from './agent-process-presence'

/** Both execution hosts use this rule; discovery carries identity without inventing a turn. */
export function admitAgentForeground(
  before: AgentHookEventPayload | undefined,
  presence: AgentProcessPresence,
  scope: Pick<
    AgentHookEventPayload,
    'paneKey' | 'connectionId' | 'worktreeId' | 'tabId' | 'terminalHandle'
  >
): AgentHookEventPayload | undefined {
  if (!presence.process || presence.ended) {
    return undefined
  }
  if (
    before &&
    (before.connectionId !== scope.connectionId || before.worktreeId !== scope.worktreeId)
  ) {
    return undefined
  }
  const recorded = before?.agentPresence
  if (recorded?.process) {
    if (!recorded.ended || isSameAgentProcess(recorded.process, presence.process)) {
      return undefined
    }
  }
  const sameTurn = before && !recorded?.ended && !before.providerSessionOnly
  return {
    ...(sameTurn ? before : {}),
    ...scope,
    agentPresence: presence,
    payload: sameTurn ? before.payload : { state: 'done', prompt: '', agentType: presence.agent },
    ...(sameTurn ? {} : { providerSessionOnly: true })
  }
}
