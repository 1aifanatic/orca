import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import type { NativeChatMessage } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

export type StructuredAgentSessionMessageProjectionOptions = {
  /** Draw a message the host accepted and then rejected where the host recorded it, as not sent.
   *  Off only for the host's outline, which older clients read too. */
  rejectedInPlace: boolean
  /** The queue's live cards: a rejected message one of them holds is drawn there, not here. */
  queuedMessageIds?: readonly string[]
}

/**
 * Whether the host's record of a send keeps it in the conversation, for every viewer. A send the
 * host recorded and then did not deliver stays, shown as not sent: dropping the sender's outbox
 * entry can never make it vanish. It leaves only where something else owns it: the user withdrew
 * it with Stop, or its queued draft's card keeps the text.
 */
export function structuredAgentSessionRecordStaysInChat(
  submission: Pick<
    AgentJournalSubmission,
    'dispatchState' | 'queuedMessageId' | 'reason' | 'rejection'
  >
): boolean {
  return (
    submission.dispatchState !== 'rejected' ||
    (!dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined)
  )
}

/**
 * The rejected submissions the host's history shows in place as not sent, by item id; `submissions`
 * in submission order, as the client keeps them. Beyond what leaves every viewer's chat
 * (`structuredAgentSessionRecordStaysInChat`), one a live card holds under its id is drawn as that
 * card, and one a later copy of the same body superseded is not drawn twice. A command such as
 * `/compact` is shown like any message: its row is where every viewer learns it did not run.
 */
export function structuredAgentSessionRejectedShownInPlace(
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[]
): Set<string> {
  const cards = new Set(queuedMessageIds)
  // Each body's copies, as positions in submission order. A withdrawn one is hidden too, so it
  // supersedes nothing.
  const copies = new Map<string, { index: number; submittedAt: number }[]>()
  for (const [index, submission] of submissions.entries()) {
    if (!dispatchWasWithdrawn(submission)) {
      const copy = { index, submittedAt: submission.submittedAt }
      const same = copies.get(submission.payloadFingerprint)
      if (same) {
        same.push(copy)
      } else {
        copies.set(submission.payloadFingerprint, [copy])
      }
    }
  }
  const shown = new Set<string>()
  for (const [index, submission] of submissions.entries()) {
    const { resolvedAt } = submission
    if (
      submission.dispatchState !== 'rejected' ||
      !structuredAgentSessionRecordStaysInChat(submission) ||
      cards.has(submission.clientMessageId) ||
      // Collapses resends of a rejected message: older builds' Retry resent it under a new id, and
      // the host re-delivers its own messages under new ids. Only a later copy sent once the
      // rejection was known counts, so a repeat sent before it is kept.
      (resolvedAt !== null &&
        (copies.get(submission.payloadFingerprint) ?? []).some(
          (copy) => copy.index > index && copy.submittedAt >= resolvedAt
        ))
    ) {
      continue
    }
    shown.add(agentJournalSubmissionKey(submission.clientMessageId))
  }
  return shown
}

/** Whether the loaded journal draws the send recorded under `clientMessageId` in the chat, where
 *  its row, not a reply, says how it went. A withdrawn, card-held or superseded copy is not drawn,
 *  so its reply still speaks. */
export function structuredAgentSessionJournalShowsSubmission(
  submissions: readonly AgentJournalSubmission[],
  clientMessageId: string
): boolean {
  const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
  return (
    submission !== undefined &&
    (submission.dispatchState !== 'rejected' ||
      structuredAgentSessionRejectedShownInPlace(submissions, []).has(
        agentJournalSubmissionKey(clientMessageId)
      ))
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
  // A refused send not drawn in place is ledger evidence, not conversation history.
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
    // After the held sends leave: they are drawn after the conversation, never inside a run.
    ...collapseProviderRetryRuns(delivered),
    ...held,
    // In no turn; the journal position keeps their place.
    ...projectItems(unsentItems).map((message) => ({ ...message, unsent: true as const })),
    ...optimistic
      .filter((entry) => {
        const id = agentJournalSubmissionKey(entry.clientMessageId)
        // A rejected one the chat would not draw in place (a card holds it, a later copy
        // superseded it) is not drawn from this copy either.
        return !journalled.has(id) && (!rejected.has(id) || inPlace.has(id))
      })
      .map((entry): NativeChatMessage => {
        const id = agentJournalSubmissionKey(entry.clientMessageId)
        return {
          id,
          role: 'user',
          source: 'transcript',
          timestamp: entry.queuedAt,
          blocks: entry.body.blocks,
          // The host rejected it and its row is not loaded yet: this copy draws it until it is.
          ...(rejected.has(id) ? { unsent: true as const } : {})
        }
      })
  ]
}
