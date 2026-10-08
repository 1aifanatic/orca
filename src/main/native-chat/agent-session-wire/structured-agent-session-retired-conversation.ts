import {
  resettleOpenStructuredAgentSessionConversation,
  type StructuredAgentSessionConversationOpenContext
} from './structured-agent-session-conversation-open'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'

/** Reuses journal settlement without entering active owner recovery or starting a provider. */
export async function restoreRetiredStructuredAgentSessionConversation(
  context: StructuredAgentSessionConversationOpenContext,
  sessionId: string
): Promise<void> {
  if (context.deps.store.getRecord(sessionId)?.lease.claimStatus !== 'released') {
    return
  }
  const session = context.sessions.get(sessionId)
  if (session) {
    await resettleOpenStructuredAgentSessionConversation(context.deps, sessionId, session)
    return
  }
  const opened = await restoreStructuredAgentSessionRead(context.deps, sessionId)
  if (opened) {
    await context.adoptOpened(sessionId, opened)
  }
}
