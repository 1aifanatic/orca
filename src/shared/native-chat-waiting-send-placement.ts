// A handed-over send waits for the turns opened before it, so it is drawn after them.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  agentJournalItemPosition,
  compareAgentJournalPositions
} from './agent-session-journal-position'
import type {
  AgentJournalPosition,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { structuredAgentTurnAnchors } from './native-chat-turn-membership'

/**
 * Where each handed-over send in no turn is drawn, by item id, when that is not its own row: past
 * the end of every turn whose opener the journal wrote before that row (its handover). Codex can
 * take a second handover before the first one's turn opens; that turn's rows then land after the
 * second send's row, though the second send waits for it. Journal order only, never a clock.
 */
export function waitingSendPositions(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): ReadonlyMap<string, AgentJournalPosition> {
  const handedOver = new Set(
    submissions.flatMap((submission) =>
      submission.handedOverAt === undefined
        ? []
        : [agentJournalSubmissionKey(submission.clientMessageId)]
    )
  )
  // A send steered into a running turn belongs to it, and stays where it joined.
  const waiting = items.filter(
    (item) => handedOver.has(item.itemId) && item.turnScope?.kind === 'thread'
  )
  const moved = new Map<string, AgentJournalPosition>()
  if (waiting.length === 0) {
    return moved
  }
  const pastTurnsOpenedBefore = turnEndsByOpener(
    items,
    structuredAgentTurnAnchors(items, submissions)
  )
  for (const item of waiting) {
    const own = agentJournalItemPosition(item)
    const position = pastTurnsOpenedBefore(own)
    if (compareAgentJournalPositions(position, own) !== 0) {
      moved.set(item.itemId, position)
    }
  }
  return moved
}

/**
 * For a point in the journal, just after the furthest row of every turn whose opener (`anchors`)
 * comes before it, or the point itself when none reaches past it. A turn a send opened is not one
 * it waited on: its opener is not before the send's own row. One pass, then a binary search.
 */
export function turnEndsByOpener(
  items: readonly AgentJournalRenderItem[],
  anchors: ReadonlyMap<string, string>
): (from: AgentJournalPosition) => AgentJournalPosition {
  const lastOfTurn = new Map<string, AgentJournalPosition>()
  const openerAt = new Map<string, AgentJournalPosition>()
  const reach = (turnItemId: string, position: AgentJournalPosition): void => {
    const last = lastOfTurn.get(turnItemId)
    if (!last || compareAgentJournalPositions(position, last) > 0) {
      lastOfTurn.set(turnItemId, position)
    }
  }
  const openers = new Set(anchors.values())
  for (const item of items) {
    const position = agentJournalItemPosition(item)
    if (openers.has(item.itemId)) {
      openerAt.set(item.itemId, position)
    }
    if (anchors.has(item.itemId)) {
      reach(item.itemId, position)
    }
    if (item.turnScope?.kind === 'turn') {
      reach(item.turnScope.turnItemId, position)
    }
  }
  const turns = [...anchors].flatMap(([turnItemId, anchorId]) => {
    const opener = openerAt.get(anchorId)
    const last = lastOfTurn.get(turnItemId)
    return opener && last ? [{ opener, last }] : []
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
    const last = low > 0 ? furthest[low - 1] : undefined
    return last && compareAgentJournalPositions(last, from) > 0
      ? { sequence: last.sequence, index: last.index + 0.5 }
      : from
  }
}
