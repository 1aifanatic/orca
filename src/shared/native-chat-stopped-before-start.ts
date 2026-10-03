// A send a Stop took back before the agent started it: where it is drawn, and the one row after it.

import { isRootAgentJournalItem } from './agent-session-journal-producer'
import {
  agentJournalItemPosition,
  compareAgentJournalItems
} from './agent-session-journal-position'
import type { AgentJournalPosition, AgentJournalRenderItem } from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

/** The row after a send a Stop took back before the agent started it; a client words it by this. */
export const NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION = 'stopped-before-start'
/** Its words where a client has no catalog of its own (the phone). */
export const NATIVE_CHAT_STOPPED_BEFORE_START_TEXT = 'Stopped before the agent started'

/** That row: it outlives any turn it sits in, as the send it follows does. */
export function isStoppedBeforeStartBlock(block: NativeChatBlock): boolean {
  return (
    block.type === 'text' && block.presentation === NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION
  )
}

/**
 * Where a send a Stop took back before its hand-over is drawn: where the Stop took it back, after
 * the rest of the turn it waited behind, not where it was accepted inside that turn.
 */
export function stoppedBeforeHandOverPosition(
  items: readonly AgentJournalRenderItem[],
  item: AgentJournalRenderItem
): AgentJournalPosition {
  let waitedBehind: AgentJournalRenderItem | undefined
  for (const candidate of items) {
    if (
      compareAgentJournalItems(candidate, item) < 0 &&
      isRootAgentJournalItem(candidate) &&
      readAgentJournalTurn(candidate.body) &&
      (!waitedBehind || compareAgentJournalItems(candidate, waitedBehind) > 0)
    ) {
      waitedBehind = candidate
    }
  }
  let last = item
  for (const candidate of items) {
    if (
      waitedBehind &&
      candidate.turnScope?.kind === 'turn' &&
      candidate.turnScope.turnItemId === waitedBehind.itemId &&
      compareAgentJournalItems(candidate, last) > 0
    ) {
      last = candidate
    }
  }
  const position = agentJournalItemPosition(last)
  // Just after that turn's last row, ahead of whatever the journal wrote next.
  return last === item ? position : { sequence: position.sequence, index: position.index + 0.5 }
}

/** One row after each run of sends a Stop took back (`stopped`, by id), placed with the last. */
export function withStopRowsAfterStoppedSends(
  messages: readonly NativeChatMessage[],
  stopped: ReadonlySet<string>
): NativeChatMessage[] {
  return messages.flatMap((message, index) =>
    stopped.has(message.id) && !stopped.has(messages[index + 1]?.id ?? '')
      ? [
          message,
          {
            id: `stopped-before-start:${message.id}`,
            role: 'system' as const,
            source: 'transcript' as const,
            timestamp: message.timestamp,
            blocks: [
              {
                type: 'text' as const,
                text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT,
                presentation: NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION
              }
            ],
            ...(message.journalPosition ? { journalPosition: message.journalPosition } : {})
          }
        ]
      : [message]
  )
}
