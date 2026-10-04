import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { agentJournalItemPosition } from './agent-session-journal-position'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import {
  keepStoppedSendsInSendOrder,
  placeStoppedSends,
  withStopRowsAfterStoppedSends
} from './native-chat-stopped-before-start'
import { compareNativeChatTranscriptMessages } from './native-chat-transcript-projection'
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
  // Runs on every streaming commit, so a chat with no such send pays nothing for placing one.
  const placement =
    stoppedBeforeStart.size > 0 ? placeStoppedSends(items, submissions, stoppedBeforeStart) : null
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
  let moved = false
  for (const message of projectItems(visibleItems)) {
    if (queued.has(message.id)) {
      held.push({ ...message, queued: true })
    } else if (!placement || !stoppedBeforeStart.has(message.id)) {
      delivered.push(message)
    } else if (placement.staysInTurn(message.id)) {
      // A turn opened for it, or it joined one (a steer): that turn's interrupted end is its stop.
      delivered.push({ ...message, stoppedBeforeStart: true })
    } else {
      const position = placement.movedTo(message.id)
      moved ||= position !== undefined
      shownStopped.add(message.id)
      delivered.push({
        ...message,
        stoppedBeforeStart: true,
        ...(position ? { journalPosition: position } : {})
      })
    }
  }
  if (shownStopped.size > 0) {
    moved = keepStoppedSendsInSendOrder(delivered, stoppedBeforeStart, shownStopped) || moved
  }
  const conversation = moved
    ? Array.from(collapseProviderRetryRuns(delivered)).sort(compareNativeChatTranscriptMessages)
    : collapseProviderRetryRuns(delivered)
  return [
    // After the held sends leave: they are drawn after the conversation, never inside a run.
    ...(shownStopped.size > 0
      ? withStopRowsAfterStoppedSends(conversation, shownStopped)
      : conversation),
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
