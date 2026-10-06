import type { AgentSessionStoreState } from './agent-session-record-store-file'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { setAgentSessionRecordConversationName } from './agent-session-record-conversation-name'

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

export async function compareAndSetAgentSessionRecordName(
  mutate: (
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ) => Promise<AgentSessionRecord>,
  name: string | null,
  expected: string | null
): Promise<AgentSessionRecord | null> {
  let matched = false
  const record = await mutate((current) => {
    matched = (current.conversationName ?? null) === expected
    return matched ? setAgentSessionRecordConversationName(current, name, Date.now()) : current
  })
  return matched ? record : null
}
