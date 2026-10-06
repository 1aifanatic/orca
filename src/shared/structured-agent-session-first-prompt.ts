import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from './structured-agent-session-command-entry'

export const STRUCTURED_CHAT_NAME_PROMPT_LIMIT = 4000

export function firstStructuredAgentSessionPrompt(
  items: readonly AgentJournalRenderItem[]
): string {
  for (const item of items) {
    const body = item.body
    if (
      body.kind !== 'message' ||
      body.role !== 'user' ||
      !isRootAgentJournalItem(item) ||
      isStructuredAgentSessionCommandEntry(body)
    ) {
      continue
    }
    let prompt = ''
    for (const block of body.blocks) {
      if (block.type === 'text') {
        if (prompt) {
          prompt += '\n'
        }
        prompt += block.text.slice(0, STRUCTURED_CHAT_NAME_PROMPT_LIMIT - prompt.length)
        if (prompt.length >= STRUCTURED_CHAT_NAME_PROMPT_LIMIT) {
          break
        }
      }
    }
    if (prompt.trim()) {
      return prompt.trim()
    }
  }
  return ''
}
