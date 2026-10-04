// Work that outlives its turn is a background-task row: a message carrying a `background-task`
// block with its own run state, the row every lane writes for it. It is not open work a turn's
// end settles, so it outlives its turn by what the row is, whichever run of the assembler ends
// that turn; only its own updates, or the session's end, change its state.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import {
  backgroundTaskFallbackText,
  canReplaceBackgroundTaskState,
  isSettledBackgroundTaskState
} from '../../../shared/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../../shared/native-chat-types'

/** The row once the host lost the session that ran its tasks: every task still in flight is
 *  `unverifiable` (nothing says it exited), with its plain-text twin restated to match. Null when
 *  no task in it is in flight. */
export function lostProviderTimelineBackgroundTasks(
  body: AgentJournalItemBody
): AgentJournalItemBody | null {
  if (body.kind !== 'message') {
    return null
  }
  const restated = new Map<string, string>()
  const blocks = body.blocks.map((block) => {
    if (!isBackgroundTaskBlock(block) || isSettledBackgroundTaskState(block.state)) {
      return block
    }
    const lost = { ...block, state: 'unverifiable' as const }
    restated.set(backgroundTaskFallbackText(block), backgroundTaskFallbackText(lost))
    return lost
  })
  if (restated.size === 0) {
    return null
  }
  return {
    ...body,
    blocks: blocks.map((block) =>
      block.type === 'text' && restated.has(block.text)
        ? { ...block, text: restated.get(block.text) ?? block.text }
        : block
    )
  }
}

/** Whether `next` would move a task `held` already settled back to a state it may not take. */
export function relightsProviderTimelineBackgroundTask(
  held: AgentJournalItemBody | null,
  next: AgentJournalItemBody
): boolean {
  if (held?.kind !== 'message' || next.kind !== 'message') {
    return false
  }
  const states = new Map<string, string>()
  for (const block of held.blocks) {
    if (isBackgroundTaskBlock(block)) {
      states.set(block.taskId, block.state)
    }
  }
  return next.blocks.some((block) => {
    const current = isBackgroundTaskBlock(block) ? states.get(block.taskId) : undefined
    return (
      isBackgroundTaskBlock(block) &&
      current !== undefined &&
      current !== block.state &&
      !canReplaceBackgroundTaskState(current, block.state)
    )
  })
}
