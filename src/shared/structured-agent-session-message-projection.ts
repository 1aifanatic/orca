import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  agentJournalItemPosition,
  compareAgentJournalPositions
} from './agent-session-journal-position'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import {
  keepStoppedSendsInSendOrder,
  latestRowsSentBefore,
  stoppedSendPosition,
  withStopRowsAfterStoppedSends
} from './native-chat-stopped-before-start'
import { compareNativeChatTranscriptMessages } from './native-chat-transcript-projection'
import { structuredAgentTurnAnchors } from './native-chat-turn-membership'
import type { NativeChatMessage } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions)
  // A send a Stop took back before the agent started it stays where it was sent, as the
  // conversation's own history. A queued card's hand-off is left out: the card holds its text.
  const stoppedBeforeStart = new Map(
    submissions
      .filter(
        (submission) => dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined
      )
      .map((submission) => [agentJournalSubmissionKey(submission.clientMessageId), submission])
  )
  // Other refused sends are ledger evidence, not conversation history; local drafts remain in the outbox.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
      .filter((itemId) => !stoppedBeforeStart.has(itemId))
  )
  const anchors = structuredAgentTurnAnchors(items, submissions)
  const anchored = new Set(anchors.values())
  const itemsById = new Map(items.map((item) => [item.itemId, item]))
  const visibleItems: AgentJournalRenderItem[] = []
  const refused = new Map<string, AgentJournalRenderItem>()
  for (const item of items) {
    if (rejected.has(item.itemId)) {
      refused.set(item.itemId, item)
    } else {
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
  const shownStopped = new Set<string>()
  const sentBefore = latestRowsSentBefore(submissions, itemsById)
  let moved = false
  for (const message of projectItems(visibleItems)) {
    if (queued.has(message.id)) {
      held.push({ ...message, queued: true })
    } else if (
      stoppedBeforeStart.has(message.id) &&
      (anchored.has(message.id) || itemsById.get(message.id)?.turnScope?.kind === 'turn')
    ) {
      // A turn opened for it, or it joined one (a steer): that turn's interrupted end is its stop.
      delivered.push({ ...message, stoppedBeforeStart: true })
    } else if (stoppedBeforeStart.has(message.id)) {
      const item = itemsById.get(message.id)
      const position = item
        ? stoppedSendPosition(
            items,
            item,
            anchors,
            stoppedBeforeStart.get(message.id)?.resolvedSequence,
            sentBefore.get(message.id)
          )
        : undefined
      const placed =
        item && position && compareAgentJournalPositions(position, agentJournalItemPosition(item))
      moved ||= Boolean(placed)
      shownStopped.add(message.id)
      delivered.push({
        ...message,
        stoppedBeforeStart: true,
        ...(placed ? { journalPosition: position } : {})
      })
    } else {
      delivered.push(message)
    }
  }
  moved = keepStoppedSendsInSendOrder(delivered, submissions, shownStopped) || moved
  return [
    // After the held sends leave: they are drawn after the conversation, never inside a run.
    ...withStopRowsAfterStoppedSends(
      moved
        ? Array.from(collapseProviderRetryRuns(delivered)).sort(compareNativeChatTranscriptMessages)
        : collapseProviderRetryRuns(delivered),
      shownStopped
    ),
    ...held,
    ...optimistic
      .filter((entry) => !journalled.has(agentJournalSubmissionKey(entry.clientMessageId)))
      .map((entry): NativeChatMessage => {
        const id = agentJournalSubmissionKey(entry.clientMessageId)
        const recorded = refused.get(id)
        return {
          id,
          role: 'user',
          source: 'transcript',
          timestamp: entry.queuedAt,
          blocks: entry.body.blocks,
          ...(entry.state === 'rejected' || structuredAgentSessionEntryHeldForRetry(entry)
            ? { unsent: true as const }
            : entry.sentWhileStopping
              ? { sentWhileStopping: true as const }
              : {}),
          // A send the journal recorded before refusing it keeps its place there.
          ...(recorded ? { journalPosition: agentJournalItemPosition(recorded) } : {})
        }
      })
  ]
}
