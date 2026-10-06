import type { AgentType } from '../../../../shared/native-chat-types'
import { chatAssigneeSessionId } from '../../orchestration/chat-assignee'
import type { OrchestrationDb } from '../../orchestration/db'
import {
  lineageLiveSession,
  readAgentSessionRecordStore
} from '../../orchestration/structured-session-lineage'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'

/** What a worker transcript read needs of the session it reads, and what its cursor is bound to. */
export type StructuredJournalSource = Pick<
  StructuredWorkerIdentity,
  'sessionId' | 'processIncarnation' | 'paneKey'
>

/**
 * A chat assignee's journal: its live session's, so a `/clear` moves the read on to the session
 * that continues the chat, and a cursor from before it is refused as a new process's would be.
 * Undefined when the assignee is not a chat; null for a chat this host has no record of.
 */
export function chatAssigneeJournalSource(
  db: OrchestrationDb,
  dispatchId: string
): { source: StructuredJournalSource; agent: AgentType } | null | undefined {
  const handle =
    db.getWorkerDispatch(dispatchId)?.agent_terminal_handle ??
    db.getDispatchContextById(dispatchId)?.assignee_handle
  const chat = chatAssigneeSessionId(handle)
  if (!handle || !chat) {
    return undefined
  }
  const store = readAgentSessionRecordStore()
  const live = store ? lineageLiveSession(store, chat) : null
  return live
    ? {
        source: { sessionId: live.sessionId, processIncarnation: live.sessionId, paneKey: handle },
        agent: live.provider
      }
    : null
}
