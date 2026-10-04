// Where a chat send goes when it comes back to the person: its text and images into the
// conversation's draft, after whatever is there, and why, once, on the chat line above the
// composer. Keyed by the conversation, not a pane, so an answer that arrives after the tab closed
// still lands where the chat is reopened.

import { useCallback, useSyncExternalStore } from 'react'
import type { AgentSessionWriteNoticePart } from '../../../../shared/agent-session-write-notice-copy'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { returnNativeChatDraftText } from './native-chat-draft-cache'
import { appendNativeChatAttachmentCache } from './use-native-chat-composer-attachments'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'

/**
 * Gives a message's text and images back to its conversation's draft. Called before the entry
 * leaves the outbox, so a failure between the two repeats the text rather than losing it; the
 * append skips text and images already there, so a repeat adds nothing.
 */
export function returnStructuredAgentSessionMessage(
  entry: StructuredAgentSessionOutboxEntry
): void {
  const scopeKey = structuredAgentSessionDraftScopeKey(entry.sessionId)
  const blocks = entry.body.blocks
  returnNativeChatDraftText(
    scopeKey,
    blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  )
  appendNativeChatAttachmentCache(
    scopeKey,
    blocks.flatMap((block, index) =>
      block.type === 'image-ref' && block.path
        ? [{ id: `returned-${entry.clientMessageId}-${index}`, path: block.path }]
        : []
    )
  )
}

type ChatLine = {
  text: string | null
  /** The message still being sent whose words these are, so they leave once it settles. */
  heldBy: string | null
  listeners: Set<() => void>
}

// Memory only: the words are said once, where the person is; the text itself is in the draft.
const chatLines = new Map<string, ChatLine>()

function chatLine(sessionId: string): ChatLine {
  let line = chatLines.get(sessionId)
  if (!line) {
    line = { text: null, heldBy: null, listeners: new Set() }
    chatLines.set(sessionId, line)
  }
  return line
}

/** Says why a send of this chat did not go through, or clears the line with null. `heldBy` names
 *  a message Orca is still sending, whose words go once it settles. */
export function setStructuredAgentSessionChatLine(
  sessionId: string,
  words: readonly AgentSessionWriteNoticePart[] | null,
  heldBy: string | null = null
): void {
  const line = chatLine(sessionId)
  const text = words ? agentSessionWriteNoticeText([...words]) : null
  line.heldBy = text === null ? null : heldBy
  if (line.text === text) {
    return
  }
  line.text = text
  for (const listener of line.listeners) {
    listener()
  }
  if (text === null && line.listeners.size === 0) {
    chatLines.delete(sessionId)
  }
}

/** Clears the line if it still says why this message is being sent again. */
export function clearStructuredAgentSessionChatLineHeldBy(
  sessionId: string,
  clientMessageId: string
): void {
  if (chatLines.get(sessionId)?.heldBy === clientMessageId) {
    setStructuredAgentSessionChatLine(sessionId, null)
  }
}

/** The chat line's text, and a way to clear it (the person's next send does). */
export function useStructuredAgentSessionChatLine(sessionId: string): string | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      const line = chatLine(sessionId)
      line.listeners.add(listener)
      return () => {
        line.listeners.delete(listener)
        if (line.listeners.size === 0 && line.text === null && chatLines.get(sessionId) === line) {
          chatLines.delete(sessionId)
        }
      }
    },
    [sessionId]
  )
  return useSyncExternalStore(subscribe, () => chatLines.get(sessionId)?.text ?? null)
}

export function resetStructuredAgentSessionChatLinesForTests(): void {
  chatLines.clear()
}
