import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { appendNativeChatAttachmentCache } from './use-native-chat-composer-attachments'

/** The text a message body carries, as the composer shows it. */
export function structuredAgentSessionMessageText(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Puts a message's text and images into a composer, after whatever is there. True once the text
 *  is durable. */
export function returnMessageToComposer(
  composerScopeKey: string,
  /** Unique to this message, so its images never collide with ones already attached. */
  attachmentIdPrefix: string,
  blocks: AgentJournalMessageItem['blocks']
): boolean {
  const durable = appendNativeChatDraftCache(
    composerScopeKey,
    structuredAgentSessionMessageText({ kind: 'message', role: 'user', blocks })
  )
  appendNativeChatAttachmentCache(
    composerScopeKey,
    blocks.flatMap((block, index) =>
      block.type === 'image-ref' && block.path
        ? [{ id: `${attachmentIdPrefix}-${index}`, path: block.path }]
        : []
    )
  )
  return durable
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
  return returnMessageToComposer(
    structuredAgentSessionDraftScopeKey(sessionId),
    `returned-${clientMessageId}`,
    body.blocks
  )
}
