// A provider retrying writes a row per attempt, and the journal keeps them all. A transcript
// draws only each agent's latest row of a run: retry rows with no other drawn row between them.

import type { NativeChatMessage } from './native-chat-types'

function isProviderRetryRow(message: NativeChatMessage): boolean {
  const block = message.blocks.length === 1 ? message.blocks[0] : undefined
  return (
    message.role === 'system' &&
    block?.type === 'text' &&
    block.failure?.kind === 'providerRetrying'
  )
}

/** The transcript draws every agent's rows inline, so agents retrying at once interleave in one
 *  run; each keeps its own row, where it first appeared, and one never hides another's. */
export function collapseProviderRetryRuns(
  messages: readonly NativeChatMessage[]
): readonly NativeChatMessage[] {
  if (!messages.some(isProviderRetryRow)) {
    return messages
  }
  const drawn: NativeChatMessage[] = []
  let runStart = 0
  for (const message of messages) {
    if (!isProviderRetryRow(message)) {
      drawn.push(message)
      runStart = drawn.length
      continue
    }
    let slot = runStart
    while (slot < drawn.length && drawn[slot]?.agentId !== message.agentId) {
      slot += 1
    }
    drawn[slot] = message
  }
  return drawn
}
