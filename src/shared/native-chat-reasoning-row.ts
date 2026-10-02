// The reasoning row, as desktop and mobile both draw it: whether it draws at all, and what its
// collapsed headline says. Read from host facts only — the row's start (`timestamp`), the end the
// host saw, and the host's live signal of which reasoning is open now — so every client tells the
// same story about one row.

import type { AgentSessionTurnActivity } from './agent-session-wire'
import { formatNativeChatDuration } from './native-chat-turn-status'
import type { NativeChatMessage } from './native-chat-types'

/** Whether the host reports reasoning open right now in the live turn: for the session's own agent
 *  without `agentId`, else for that subagent. The one gate every live "Thinking" reads; a host that
 *  sends no signal (an older one) reports nothing open. */
export function nativeChatReasoningOpen(
  activity: AgentSessionTurnActivity | null | undefined,
  liveTurnId: string | null,
  agentId?: string
): boolean {
  if (!liveTurnId || activity?.turnId !== liveTurnId || !activity.reasoning) {
    return false
  }
  return agentId === undefined
    ? activity.reasoning.session === true
    : activity.reasoning.subagents.includes(agentId)
}

/** A reasoning row still being written while the host reports its reasoning open. It draws nothing
 *  until it ends: the live "Thinking" already says so, and one live indicator is enough. */
export function isNativeChatReasoningUnderway(
  message: Pick<NativeChatMessage, 'role' | 'state'>,
  reasoningOpen: boolean
): boolean {
  return message.role === 'reasoning' && message.state === 'running' && reasoningOpen
}

export type NativeChatReasoningHeadline =
  /** From a host that kept no lifecycle: nothing is claimed. */
  | { kind: 'reasoning' }
  /** Ended, with no span the host saw. */
  | { kind: 'thought' }
  | { kind: 'thoughtFor'; duration: string }

export function nativeChatReasoningHeadline(
  message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>
): NativeChatReasoningHeadline {
  if (message.state === undefined) {
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
