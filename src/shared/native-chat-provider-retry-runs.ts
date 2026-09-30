// A provider retrying writes a row per attempt, and the journal keeps them all. A transcript
// draws only the latest row of each run: retry rows with no other drawn row between them.

import type { NativeChatMessage } from './native-chat-types'

function isProviderRetryRow(message: NativeChatMessage): boolean {
  const block = message.blocks.length === 1 ? message.blocks[0] : undefined
  return (
    message.role === 'system' &&
    block?.type === 'text' &&
    block.failure?.kind === 'providerRetrying'
  )
}

/** `agentOf` names the row's producer: the transcript draws every agent's rows inline, and one
 *  agent's retries must not hide another's. */
export function collapseProviderRetryRuns(
  messages: readonly NativeChatMessage[],
  agentOf: (messageId: string) => string | undefined
): readonly NativeChatMessage[] {
  if (!messages.some(isProviderRetryRow)) {
    return messages
  }
  const drawn: NativeChatMessage[] = []
  for (const message of messages) {
    const previous = drawn.at(-1)
    if (
      previous &&
      isProviderRetryRow(previous) &&
      isProviderRetryRow(message) &&
      agentOf(previous.id) === agentOf(message.id)
    ) {
      drawn[drawn.length - 1] = message
    } else {
      drawn.push(message)
    }
  }
  return drawn
}
