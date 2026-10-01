// What a Claude `system/informational` frame shows. Claude Code renders `info`, `notice` and
// `suggestion` as transcript chrome; only a `warning` (a Stop hook that refused to continue, say)
// earns a row, in the frame's own words.

import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { claudeText } from './claude-structured-item-translation'

export const CLAUDE_INFORMATIONAL_FRAME_KIND = 'message:system:informational'

/** The row a warning-level note writes; null for every other level and for a warning with no words. */
export function claudeInformationalRowBody(
  message: Record<string, unknown>
): AgentJournalStatusItem | null {
  const text = message.level === 'warning' ? claudeText(message.content)?.trim() : null
  return text
    ? {
        kind: 'status',
        tone: 'warning',
        text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      }
    : null
}
