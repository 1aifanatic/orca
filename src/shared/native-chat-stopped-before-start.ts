// A send a Stop took back before the agent started it: where it is drawn, and the one row after it.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  agentJournalItemPosition,
  compareAgentJournalItems,
  compareAgentJournalPositions
} from './agent-session-journal-position'
import type {
  AgentJournalPosition,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
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
 * Where a send a Stop took back is drawn: at the journal row that took it back (`resolvedSequence`),
 * past the end of every turn whose opener (`anchors`) the journal wrote before that row. Journal
 * order only, never a clock.
 * Temporary, until a host version floor: a host that predates `resolvedSequence` keeps the earlier
 * rule, from the later of its own row and `sentBefore` (see `latestRowsSentBefore`).
 */
export function stoppedSendPosition(
  items: readonly AgentJournalRenderItem[],
  item: AgentJournalRenderItem,
  anchors: ReadonlyMap<string, string>,
  resolvedSequence: number | undefined,
  sentBefore?: AgentJournalRenderItem
): AgentJournalPosition {
  const own = agentJournalItemPosition(item)
  const floor = sentBefore ? agentJournalItemPosition(sentBefore) : undefined
  // Just after the floor row, so a turn that row opened counts as waited on.
  const from =
    resolvedSequence !== undefined
      ? { sequence: resolvedSequence, index: 0 }
      : floor && compareAgentJournalPositions(floor, own) > 0
        ? { sequence: floor.sequence, index: floor.index + 0.5 }
        : own
  const byId = new Map(items.map((candidate) => [candidate.itemId, candidate]))
  const waitedOn = new Set<string>()
  for (const [turnItemId, anchorId] of anchors) {
    const opener = byId.get(anchorId)
    if (
      anchorId !== item.itemId &&
      opener &&
      compareAgentJournalPositions(agentJournalItemPosition(opener), from) < 0
    ) {
      waitedOn.add(turnItemId)
    }
  }
  let last = from
  for (const candidate of items) {
    const ofTurn =
      waitedOn.has(candidate.itemId) ||
      (candidate.turnScope?.kind === 'turn' && waitedOn.has(candidate.turnScope.turnItemId))
    const position = agentJournalItemPosition(candidate)
    if (ofTurn && compareAgentJournalPositions(position, last) > 0) {
      last = { sequence: position.sequence, index: position.index + 0.5 }
    }
  }
  return last
}

/** For each submission, the latest loaded row of the ones sent before it, in `submittedAt` order
 *  with ties kept in list order as the client reducer keeps them. Temporary: read only for a host
 *  that predates `resolvedSequence`. */
export function latestRowsSentBefore(
  submissions: readonly AgentJournalSubmission[],
  itemsById: ReadonlyMap<string, AgentJournalRenderItem>
): ReadonlyMap<string, AgentJournalRenderItem> {
  const inSendOrder = submissions
    .map((submission, order) => ({ submission, order }))
    .sort(
      (left, right) =>
        left.submission.submittedAt - right.submission.submittedAt || left.order - right.order
    )
  const before = new Map<string, AgentJournalRenderItem>()
  let latest: AgentJournalRenderItem | undefined
  for (const { submission } of inSendOrder) {
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    if (latest) {
      before.set(key, latest)
    }
    const row = itemsById.get(key)
    if (row && (!latest || compareAgentJournalItems(row, latest) > 0)) {
      latest = row
    }
  }
  return before
}

/**
 * Sends a Stop took back (`stopped`, by id) keep the order they were sent in: a later one is drawn
 * no earlier than just after an earlier one. Sent order is the published `submittedSequence`.
 * Temporary, until a host version floor: a host that predates it gives `submittedAt`, its accept
 * time, with ties kept in list order as the client reducer keeps them. Returns whether it moved any.
 */
export function keepStoppedSendsInSendOrder(
  messages: NativeChatMessage[],
  submissions: readonly AgentJournalSubmission[],
  stopped: ReadonlySet<string>
): boolean {
  const indexById = new Map(messages.map((message, index) => [message.id, index]))
  const taken = submissions
    .map((submission, order) => ({
      index: indexById.get(agentJournalSubmissionKey(submission.clientMessageId)),
      submission,
      order
    }))
    .filter((entry) => entry.index !== undefined && stopped.has(messages[entry.index]!.id))
  const byJournal = taken.every((entry) => entry.submission.submittedSequence !== undefined)
  const sent = taken.sort(
    (left, right) =>
      (byJournal
        ? left.submission.submittedSequence! - right.submission.submittedSequence!
        : left.submission.submittedAt - right.submission.submittedAt) || left.order - right.order
  )
  let floor: AgentJournalPosition | undefined
  let moved = false
  for (const { index } of sent) {
    const message = messages[index!]!
    const position = message.journalPosition
    if (!position) {
      continue
    }
    if (floor && compareAgentJournalPositions(position, floor) <= 0) {
      floor = { sequence: floor.sequence, index: floor.index + 1 / 1024 }
      messages[index!] = { ...message, journalPosition: floor }
      moved = true
    } else {
      floor = position
    }
  }
  return moved
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
