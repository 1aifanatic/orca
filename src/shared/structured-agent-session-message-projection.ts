import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { compareAgentJournalPositions } from './agent-session-journal-position'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import type { NativeChatMessage } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

export type StructuredAgentSessionMessageProjectionOptions = {
  /** Draw a message the host accepted and then rejected where the host recorded it, as not sent.
   *  Off for a client that hands such a message back to its composer instead. */
  rejectedInPlace: boolean
  /** The queue's live cards: a rejected message one of them holds is drawn there, not here. */
  queuedMessageIds?: readonly string[]
}

/**
 * The rejected submissions the host's history shows in place as not sent, by item id. A withdrawn
 * one went back to its sender, and one the queue holds (a draft's hand-off, or a card under its id)
 * is drawn as its card. Every other one stays, a command such as `/compact` included, whatever was
 * sent after it: a resend of its text is a new message, and the row is the record of the failure.
 */
export function structuredAgentSessionRejectedShownInPlace(
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[]
): Set<string> {
  const cards = new Set(queuedMessageIds)
  const shown = new Set<string>()
  for (const submission of submissions) {
    if (
      submission.dispatchState !== 'rejected' ||
      dispatchWasWithdrawn(submission) ||
      submission.queuedMessageId !== undefined ||
      cards.has(submission.clientMessageId)
    ) {
      continue
    }
    shown.add(agentJournalSubmissionKey(submission.clientMessageId))
  }
  return shown
}

/** Whether the loaded journal already draws the send recorded under `clientMessageId` as not sent,
 *  so its row, not a reply, says it failed. One still pending may yet be withdrawn and hidden. */
export function structuredAgentSessionJournalShowsRejection(
  submissions: readonly AgentJournalSubmission[],
  clientMessageId: string
): boolean {
  const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
  return (
    submission?.dispatchState === 'rejected' &&
    structuredAgentSessionRejectedShownInPlace(submissions, []).has(
      agentJournalSubmissionKey(clientMessageId)
    )
  )
}

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  options: StructuredAgentSessionMessageProjectionOptions,
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions, items)
  // Refused sends are ledger evidence, not conversation history, unless drawn in place as not sent.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const inPlace = options.rejectedInPlace
    ? structuredAgentSessionRejectedShownInPlace(submissions, options.queuedMessageIds ?? [])
    : new Set<string>()
  const visibleItems: AgentJournalRenderItem[] = []
  const unsentItems: AgentJournalRenderItem[] = []
  for (const item of items) {
    if (inPlace.has(item.itemId)) {
      unsentItems.push(item)
    } else if (!rejected.has(item.itemId)) {
      visibleItems.push(item)
    }
  }
  const journalled = new Set(visibleItems.map((item) => item.itemId))
  // Not delivered yet, so nothing the agent does meanwhile — a command it waits behind — comes
  // after it. Its handover places it in the conversation.
  const queued = new Set(
    submissions
      .filter(isQueuedAgentJournalSubmission)
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const delivered: NativeChatMessage[] = []
  const held: NativeChatMessage[] = []
  for (const message of projectItems(visibleItems)) {
    if (queued.has(message.id)) {
      held.push({ ...message, queued: true })
    } else {
      delivered.push(message)
    }
  }
  return [
    // In no turn, like the outbox's not-sent rows, and at their journal places, so a reader that
    // draws this list as it comes (the phone) puts them where the host recorded them.
    ...inJournalOrder(
      // After the held sends leave: they are drawn after the conversation, never inside a run.
      collapseProviderRetryRuns(delivered),
      projectItems(unsentItems).map((message) => ({ ...message, unsent: true as const }))
    ),
    ...held,
    ...optimistic
      .filter((entry) => !journalled.has(agentJournalSubmissionKey(entry.clientMessageId)))
      .map((entry): NativeChatMessage => ({
        id: agentJournalSubmissionKey(entry.clientMessageId),
        role: 'user',
        source: 'transcript',
        timestamp: entry.queuedAt,
        blocks: entry.body.blocks,
        ...(entry.state === 'rejected' || structuredAgentSessionEntryHeldForRetry(entry)
          ? { unsent: true as const }
          : {})
      }))
  ]
}

/** `rows`, already in journal order, with `placed` merged in at their journal positions. A placed
 *  row the host moved to its rejection can sit anywhere in `items`, so it is ordered first. */
function inJournalOrder(
  rows: readonly NativeChatMessage[],
  unordered: readonly NativeChatMessage[]
): readonly NativeChatMessage[] {
  if (unordered.length === 0) {
    return rows
  }
  // Not `toSorted`: mobile's Hermes lacks it, and src/shared must stay loadable there.
  const placed = Array.from(unordered).sort((a, b) =>
    journalPlaceBefore(a, b) ? -1 : journalPlaceBefore(b, a) ? 1 : 0
  )
  const merged: NativeChatMessage[] = []
  let next = 0
  for (const row of rows) {
    for (let early = placed[next]; early && journalPlaceBefore(early, row); early = placed[next]) {
      merged.push(early)
      next += 1
    }
    merged.push(row)
  }
  return merged.concat(placed.slice(next))
}

function journalPlaceBefore(a: NativeChatMessage, b: NativeChatMessage): boolean {
  return (
    a.journalPosition !== undefined &&
    b.journalPosition !== undefined &&
    compareAgentJournalPositions(a.journalPosition, b.journalPosition) < 0
  )
}
