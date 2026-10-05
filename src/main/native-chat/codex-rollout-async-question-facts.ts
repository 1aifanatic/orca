import type { NativeChatAsyncQuestionFact } from '../../shared/native-chat-async-questions'
import { nativeChatTranscriptAsyncQuestionFacts } from '../../shared/native-chat-async-question-facts'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

// Cheap prefilter: most rollout lines (tool output) cannot carry a fact and skip JSON parsing.
const FACT_MARKERS = ['user_message', 'UserMessage', '_async', '"async"'] as const

/** Only Codex's own user-message events count as delivered: injected context records
 *  (environment, instructions) are user-role response items but never these events. */
function isDeliveredUserRecord(record: Record<string, unknown>): boolean {
  if (record.type !== 'event_msg') {
    return false
  }
  const payload = asRecord(record.payload)
  if (payload?.type === 'user_message') {
    return true
  }
  const item = payload?.type === 'item_completed' ? asRecord(payload.item) : null
  return item?.type === 'UserMessage' || item?.type === 'user_message'
}

/** Async-question facts of one rollout line, in record order. */
export function codexRolloutAsyncQuestionFacts(
  line: string,
  recordId: string
): NativeChatAsyncQuestionFact[] {
  if (!FACT_MARKERS.some((marker) => line.includes(marker))) {
    return []
  }
  const record = parseJsonObject(line)
  if (!record) {
    return []
  }
  if (isDeliveredUserRecord(record)) {
    return [{ kind: 'delivered-user-message', author: 'root' }]
  }
  const message = decodeCodexTranscriptLine(line, recordId)
  return message ? nativeChatTranscriptAsyncQuestionFacts(message) : []
}
