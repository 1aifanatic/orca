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
import { structuredAgentTurnAnchors } from './native-chat-turn-membership'
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

/** Where the sends a Stop took back are drawn, worked out once per projection. */
export type StoppedSendPlacement = {
  /** Whether it stays in a turn: one opened for it, or one it was steered into. That turn's
   *  interrupted end is its stop. */
  staysInTurn(itemId: string): boolean
  /** Where it is drawn when that is not its own row. */
  movedTo(itemId: string): AgentJournalPosition | undefined
}

/**
 * A send a Stop took back (`stopped`, by item id) is drawn at the journal row that took it back
 * (`resolvedSequence`), past the end of every turn whose opener the journal wrote before that row.
 * Journal order only, never a clock.
 * Temporary, until a host version floor: a host that predates `resolvedSequence` keeps the earlier
 * rule, from the later of its own row and just after `latestRowsSentBefore`.
 */
export function placeStoppedSends(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  stopped: ReadonlyMap<string, AgentJournalSubmission>
): StoppedSendPlacement {
  const anchors = structuredAgentTurnAnchors(items, submissions)
  const anchored = new Set(anchors.values())
  const itemsById = new Map(items.map((item) => [item.itemId, item]))
  const pastTurnsOpenedBefore = turnEndsByOpener(items, anchors, itemsById)
  const sentBefore = [...stopped.values()].some(
    (submission) => submission.resolvedSequence === undefined
  )
    ? latestRowsSentBefore(submissions, itemsById)
    : undefined
  return {
    staysInTurn: (itemId) =>
      anchored.has(itemId) || itemsById.get(itemId)?.turnScope?.kind === 'turn',
    movedTo: (itemId) => {
      const item = itemsById.get(itemId)
      if (!item) {
        return undefined
      }
      const own = agentJournalItemPosition(item)
      const resolvedSequence = stopped.get(itemId)?.resolvedSequence
      const sentBeforeRow = sentBefore?.get(itemId)
      const floor = sentBeforeRow ? agentJournalItemPosition(sentBeforeRow) : undefined
      // Just after the floor row, so a turn that row opened counts as waited on.
      const from =
        resolvedSequence !== undefined
          ? { sequence: resolvedSequence, index: 0 }
          : floor && compareAgentJournalPositions(floor, own) > 0
            ? { sequence: floor.sequence, index: floor.index + 0.5 }
            : own
      const position = pastTurnsOpenedBefore(from)
      return compareAgentJournalPositions(position, own) !== 0 ? position : undefined
    }
  }
}

/**
 * For a point in the journal, just after the furthest row of every turn whose opener comes before
 * it, or the point itself when none reaches past it. One pass over the items, then a binary search
 * per point. A send placed here is never a turn's opener (`staysInTurn`), so no turn is its own.
 */
function turnEndsByOpener(
  items: readonly AgentJournalRenderItem[],
  anchors: ReadonlyMap<string, string>,
  itemsById: ReadonlyMap<string, AgentJournalRenderItem>
): (from: AgentJournalPosition) => AgentJournalPosition {
  const lastOfTurn = new Map<string, AgentJournalPosition>()
  const reach = (turnItemId: string, position: AgentJournalPosition): void => {
    const last = lastOfTurn.get(turnItemId)
    if (!last || compareAgentJournalPositions(position, last) > 0) {
      lastOfTurn.set(turnItemId, position)
    }
  }
  for (const item of items) {
    const position = agentJournalItemPosition(item)
    if (anchors.has(item.itemId)) {
      reach(item.itemId, position)
    }
    if (item.turnScope?.kind === 'turn') {
      reach(item.turnScope.turnItemId, position)
    }
  }
  const turns = [...anchors].flatMap(([turnItemId, anchorId]) => {
    const opener = itemsById.get(anchorId)
    const last = lastOfTurn.get(turnItemId)
    return opener && last ? [{ opener: agentJournalItemPosition(opener), last }] : []
  })
  turns.sort((left, right) => compareAgentJournalPositions(left.opener, right.opener))
  // The furthest row of the turns opened up to each one.
  const furthest: AgentJournalPosition[] = []
  for (const turn of turns) {
    const previous = furthest.at(-1)
    furthest.push(
      previous && compareAgentJournalPositions(previous, turn.last) > 0 ? previous : turn.last
    )
  }
  return (from) => {
    let low = 0
    let high = turns.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (compareAgentJournalPositions(turns[middle]!.opener, from) < 0) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    const last = low > 0 ? furthest[low - 1]! : undefined
    return last && compareAgentJournalPositions(last, from) > 0
      ? { sequence: last.sequence, index: last.index + 0.5 }
      : from
  }
}

/** For each submission, the latest loaded row of the ones sent before it, in `submittedAt` order
 *  with ties kept in list order as the client reducer keeps them. Temporary: read only for a host
 *  that predates `resolvedSequence`. */
function latestRowsSentBefore(
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
 * Sends a Stop took back (`stopped`, by item id, in list order) and drawn on their own (`shown`)
 * keep the order they were sent in: a later one is drawn no earlier than just after an earlier
 * one. Sent order is the published `submittedSequence`.
 * Temporary, until a host version floor: a host that predates it gives `submittedAt`, its accept
 * time, with ties kept in list order as the client reducer keeps them. Returns whether it moved any.
 */
export function keepStoppedSendsInSendOrder(
  messages: NativeChatMessage[],
  stopped: ReadonlyMap<string, AgentJournalSubmission>,
  shown: ReadonlySet<string>
): boolean {
  const indexById = new Map<string, number>()
  messages.forEach((message, index) => {
    if (shown.has(message.id)) {
      indexById.set(message.id, index)
    }
  })
  const taken = [...stopped].flatMap(([itemId, submission], order) => {
    const index = indexById.get(itemId)
    return index === undefined ? [] : [{ index, submission, order }]
  })
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
    const message = messages[index]!
    const position = message.journalPosition
    if (!position) {
      continue
    }
    if (floor && compareAgentJournalPositions(position, floor) <= 0) {
      floor = { sequence: floor.sequence, index: floor.index + 1 / 1024 }
      messages[index] = { ...message, journalPosition: floor }
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
