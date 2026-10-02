import type { NativeChatMessage } from './native-chat-types'

/** A reasoning row still being written in a turn that is running. It draws nothing until it ends:
 *  the turn's activity line is what says the agent is thinking, and one live indicator is enough. */
export function isNativeChatReasoningUnderway(
  message: Pick<NativeChatMessage, 'role' | 'state'>,
  turnIsWorking: boolean
): boolean {
  return message.role === 'reasoning' && message.state === 'running' && turnIsWorking
}
