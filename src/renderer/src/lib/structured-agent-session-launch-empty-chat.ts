import { getStructuredAgentSessionOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { readNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
// The draft store, not the composer hook: the launch must not load the composer (a store cycle).
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'

/** A starting chat is empty until its user sends into it or puts text or images in its draft (typed,
 *  or given back); after that it is theirs, and another request never goes into it. Read by the
 *  conversation's key, which the composer and every hand-back write. */
export function isStructuredLaunchChatEmpty(sessionId: string): boolean {
  const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
  return (
    getStructuredAgentSessionOutbox(sessionId).length === 0 &&
    readNativeChatDraftCache(scopeKey).trim() === '' &&
    readNativeChatComposerDraft(scopeKey).images.length === 0
  )
}
