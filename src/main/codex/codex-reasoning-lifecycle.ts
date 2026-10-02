import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'

export type CodexReasoningLifecycle = Pick<AgentJournalMessageItem, 'state' | 'completedAt'>

/** Null for blank reasoning: an item with no readable text journals no row. */
export function codexReasoningBody(
  text: string | null,
  lifecycle: CodexReasoningLifecycle = {}
): AgentJournalMessageItem | null {
  return text?.trim()
    ? {
        kind: 'message',
        role: 'reasoning',
        blocks: [
          { type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
        ],
        ...lifecycle
      }
    : null
}

/** Stamps a reasoning row with whether its item is still open, as the caller knows it; every other
 *  body passes through untouched. */
export function withCodexReasoningLifecycle(
  body: AgentJournalItemBody,
  lifecycle: CodexReasoningLifecycle
): AgentJournalItemBody {
  return body.kind === 'message' && body.role === 'reasoning' ? { ...body, ...lifecycle } : body
}

/** A reasoning row's end: `completedAt` is when the host saw it end, its item's completion or the
 *  turn or exit that cut it off; absent when no end was seen live. */
export function endedCodexReasoning(completedAt?: number): CodexReasoningLifecycle {
  return { state: 'completed', ...(completedAt === undefined ? {} : { completedAt }) }
}
