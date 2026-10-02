// How a page or live batch merges into the items and submissions a client retains.

import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { compareAgentJournalItems } from './agent-session-journal-position'
import type { StructuredAgentSessionState } from './structured-agent-session-reducer'

const MAX_RETAINED_SUBMISSIONS = 256

export function mergeItems(
  current: readonly AgentJournalRenderItem[],
  incoming: readonly AgentJournalRenderItem[],
  removedIds: readonly string[]
): AgentJournalRenderItem[] {
  const removed = new Set(removedIds)
  const byId = new Map(
    current.filter((item) => !removed.has(item.itemId)).map((item) => [item.itemId, item])
  )
  for (const item of incoming) {
    const prior = byId.get(item.itemId)
    if (!prior || item.revision >= prior.revision) {
      byId.set(item.itemId, item)
    }
  }
  return [...byId.values()].sort(compareAgentJournalItems)
}

/**
 * Live rows the loaded window can take. The window is a contiguous suffix of the
 * journal, and its oldest row is the load-older anchor. A revision of a row older
 * than the window keeps that row's original sequence, so admitting it would move
 * the anchor below the window and paging `before` it would skip every row between.
 * The journal keeps the revision; the page reader serves it once the window
 * reaches the row. With nothing older on the host the window is the whole journal
 * and a row below the head (a revived tombstone) leaves no hole, so it is admitted.
 */
export function liveItemsWithinWindow(
  state: StructuredAgentSessionState,
  incoming: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  const head = state.items[0]
  if (!head || !state.hasOlder) {
    return incoming
  }
  return incoming.filter((item) => item.sequence >= head.sequence)
}

export function mergeSubmissions(
  current: readonly AgentJournalSubmission[],
  incoming: readonly AgentJournalSubmission[],
  items: readonly AgentJournalRenderItem[]
): AgentJournalSubmission[] {
  const byId = new Map(current.map((submission) => [submission.clientMessageId, submission]))
  for (const submission of incoming) {
    byId.set(submission.clientMessageId, submission)
  }
  const sorted = [...byId.values()].sort((left, right) => left.submittedAt - right.submittedAt)
  const itemIds = new Set(
    items
      .filter((item) => item.body.kind === 'message' && item.body.role === 'user')
      .map((item) => item.itemId)
  )
  // Loaded user messages need their provider alias for durable turn attribution.
  return sorted.filter(
    (submission, index) =>
      index >= sorted.length - MAX_RETAINED_SUBMISSIONS ||
      itemIds.has(agentJournalSubmissionKey(submission.clientMessageId))
  )
}
