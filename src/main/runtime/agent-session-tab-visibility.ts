import type { AgentSessionStoreState } from './agent-session-record-store-file'

export function listVisibleAgentSessionIds(state: AgentSessionStoreState): string[] {
  return (state.sessionTabs?.sessionIds() ?? []).filter((sessionId) => state.records.has(sessionId))
}

/** Include pre-index tabs only while the durable visibility index is absent. */
export function getAgentSessionVisibleTabIndex(state: AgentSessionStoreState): {
  present: boolean
  sessionIds: string[]
} {
  return {
    present: state.sessionTabs !== null,
    sessionIds: state.sessionTabs
      ? listVisibleAgentSessionIds(state)
      : (state.unrecordedSessionTabs?.sessionIds() ?? []).filter((sessionId) =>
          state.records.has(sessionId)
        )
  }
}
