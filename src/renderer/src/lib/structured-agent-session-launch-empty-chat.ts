import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { readNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'

/** A starting chat is empty until its user sends into it or types in its composer; after that it
 *  is theirs, and another request's text never goes into it. */
export function isStructuredLaunchChatEmpty(sessionId: string): boolean {
  const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
  return (
    getStructuredAgentSessionOutbox(sessionId).length === 0 &&
    readNativeChatDraftCache(paneKey).trim() === ''
  )
}
