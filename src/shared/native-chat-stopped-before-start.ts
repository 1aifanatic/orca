// A send a Stop took back before the agent started it: where it is drawn, and the one row after it.

import {
  agentJournalItemPosition,
  compareAgentJournalItems
} from './agent-session-journal-position'
import type { AgentJournalPosition, AgentJournalRenderItem } from './agent-session-journal-types'
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
 * Where a send a Stop took back is drawn: after the rest of every turn it waited on, where the Stop
 * took it back, else at its own row. A turn it waited on is one whose opener (`anchors`) the journal
 * places before the send's row: the turn it was accepted behind, or one that opened for an earlier
 * row while it waited. A handed-over send's row is its handover, not when it was sent. Journal order
 * only, never a clock: a resume rewrites a turn's start time to the provider's whole seconds.
 */
export function stoppedSendPosition(
  items: readonly AgentJournalRenderItem[],
  item: AgentJournalRenderItem,
  anchors: ReadonlyMap<string, string>
): AgentJournalPosition {
  const byId = new Map(items.map((candidate) => [candidate.itemId, candidate]))
  const waitedOn = new Set<string>()
  for (const [turnItemId, anchorId] of anchors) {
    const opener = byId.get(anchorId)
    if (anchorId !== item.itemId && opener && compareAgentJournalItems(opener, item) < 0) {
      waitedOn.add(turnItemId)
    }
  }
  let last = item
  for (const candidate of items) {
    const ofTurn =
      waitedOn.has(candidate.itemId) ||
      (candidate.turnScope?.kind === 'turn' && waitedOn.has(candidate.turnScope.turnItemId))
    if (ofTurn && compareAgentJournalItems(candidate, last) > 0) {
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
