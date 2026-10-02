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

/** The end a reasoning row gets when its item will never complete: `completedAt` only when the
 *  host saw the end happen (the turn ending), never for an inferred one. */
export function endedCodexReasoning(completedAt?: number): CodexReasoningLifecycle {
  return { state: 'completed', ...(completedAt === undefined ? {} : { completedAt }) }
}
