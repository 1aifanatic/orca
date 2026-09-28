// The transcript's projection of a conversation's messages into the rows it draws:
// ordered, tool runs folded into the turn that made them, harness turns dropped.
// Shared so the host's conversation outline asks "which user messages draw a row?"
// of exactly what the renderer's transcript runs, not a second reading of it.

import type { NativeChatMessage } from './native-chat-types'
import { stripNoiseMessages } from './native-chat-noise'
import { foldToolMessages } from './native-chat-tool-fold'

/** Timestamp only. A null timestamp sorts first so a source that cannot supply
 *  one stays in place rather than jumping to the end. */
export function compareNativeChatMessageTimes(a: NativeChatMessage, b: NativeChatMessage): number {
  const at = a.timestamp ?? Number.NEGATIVE_INFINITY
  const bt = b.timestamp ?? Number.NEGATIVE_INFINITY
  return at === bt ? 0 : at - bt
}

/** Timestamp, then id: a total order for merging sources that share no order of their own. */
export function compareNativeChatMessagesByTime(
  a: NativeChatMessage,
  b: NativeChatMessage
): number {
  const byTime = compareNativeChatMessageTimes(a, b)
  if (byTime !== 0) {
    return byTime
  }
  if (a.id < b.id) {
    return -1
  }
  if (a.id > b.id) {
    return 1
  }
  return 0
}

/** Rows that tie keep the order they arrive in: rows written together share a
 *  timestamp, and only their source knows which came first — a Codex ask
 *  journals all of its questions in one write. `compare` lets the renderer order
 *  its own tail rows (streaming, optimistic sends), which never exist on the host. */
export function projectNativeChatTranscriptMessages(
  messages: readonly NativeChatMessage[],
  compare: (a: NativeChatMessage, b: NativeChatMessage) => number = compareNativeChatMessageTimes
): NativeChatMessage[] {
  // Not `toSorted`: mobile's Hermes lacks it, and src/shared must stay loadable there.
  return stripNoiseMessages(foldToolMessages(Array.from(messages).sort(compare)))
}
