import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { appendNativeChatAttachmentCache } from './use-native-chat-composer-attachments'

/** The text a message body carries, as the composer shows it. */
export function structuredAgentSessionMessageText(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** The images a message body carries, as composer attachments. */
export function structuredAgentSessionMessageImages(
  clientMessageId: string,
  body: AgentJournalMessageItem
): { id: string; path: string }[] {
  return body.blocks.flatMap((block, index) =>
    block.type === 'image-ref' && block.path
      ? [{ id: `returned-${clientMessageId}-${index}`, path: block.path }]
      : []
  )
}

/**
 * Puts a message that did not reach the host back in its chat's composer, after whatever is
 * there: the chat's draft is keyed by its conversation, so this works with or without its view
 * mounted. True once the text is durable.
 */
export function handBackStructuredAgentSessionMessage(
  sessionId: string,
  clientMessageId: string,
  body: AgentJournalMessageItem
): boolean {
  const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
  const durable = appendNativeChatDraftCache(scopeKey, structuredAgentSessionMessageText(body))
  appendNativeChatAttachmentCache(
    scopeKey,
    structuredAgentSessionMessageImages(clientMessageId, body)
  )
  return durable
}
