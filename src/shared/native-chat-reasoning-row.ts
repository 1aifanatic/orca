// The reasoning row, as desktop and mobile both draw it: which open block the live activity line
// discloses, and what a row's collapsed headline says. Read from host facts only — the row's start
// (`timestamp`) and the end the host saw — so every client tells the same story about one row.

import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { deriveNativeChatRowContent, nativeChatRowRendersContent } from './native-chat-row-content'
import { formatNativeChatDuration } from './native-chat-turn-status'
import type { NativeChatMessage } from './native-chat-types'

/**
 * The open reasoning block the live activity line discloses, or null. Its row draws nothing while
 * this returns it, so the line is the one live "Thinking" and nothing is ever hidden that the
 * screen does not show. `lineShowsThinking` must be the line's own render condition.
 */
export function selectNativeChatLiveReasoning(
  messages: readonly NativeChatMessage[],
  inLiveWorkingTurn: (index: number) => boolean,
  lineShowsThinking: boolean
): NativeChatMessage | null {
  if (!lineShowsThinking) {
    return null
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || !inLiveWorkingTurn(index)) {
      continue
    }
    if (message.role === 'user') {
      return null
    }
    // A notice is not newer content, and a subagent's reasoning draws in its own section.
    if (message.role === 'system' || !isRootAgentJournalItem(message)) {
      continue
    }
    if (message.role !== 'reasoning') {
      if (!nativeChatRowRendersContent(message.blocks)) {
        continue
      }
      return null
    }
    // Not `=== 'running'`: a host that keeps no lifecycle gets the same single live slot.
    return message.state !== 'completed' &&
      deriveNativeChatRowContent(message.blocks).markdown.trim().length > 0
      ? message
      : null
  }
  return null
}

/** One key per reasoning block, read by the live line and the finished row alike. */
export function nativeChatReasoningDisclosureKey(messageId: string): string {
  return `reasoning:${messageId}`
}

export type NativeChatReasoningHeadline =
  /** From a host that kept no lifecycle, or not yet ended: nothing is claimed. */
  | { kind: 'reasoning' }
  /** Ended, with no span the host saw. */
  | { kind: 'thought' }
  | { kind: 'thoughtFor'; duration: string }

/** `live`: the row is drawn inside its working turn or working subagent. */
export function nativeChatReasoningHeadline(
  message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>,
  { live }: { live: boolean }
): NativeChatReasoningHeadline {
  // Not ended yet, so it claims no past tense.
  if (message.state === undefined || (live && message.state !== 'completed')) {
    return { kind: 'reasoning' }
  }
  // An open row in a turn that is no longer live ended unseen, so it claims no duration.
  if (
    message.state !== 'completed' ||
    message.completedAt === undefined ||
    message.timestamp === null
  ) {
    return { kind: 'thought' }
  }
  return {
    kind: 'thoughtFor',
    duration: formatNativeChatDuration(
      Math.max(1, (message.completedAt - message.timestamp) / 1000)
    )
  }
}

/** English copy for clients without a translation catalog; desktop translates the same three. */
const NATIVE_CHAT_REASONING_COPY = {
  reasoning: 'Reasoning',
  thought: 'Thought',
  thoughtFor: (duration: string) => `Thought for ${duration}`
} as const

export function nativeChatReasoningHeadlineText(headline: NativeChatReasoningHeadline): string {
  return headline.kind === 'thoughtFor'
    ? NATIVE_CHAT_REASONING_COPY.thoughtFor(headline.duration)
    : NATIVE_CHAT_REASONING_COPY[headline.kind]
}
