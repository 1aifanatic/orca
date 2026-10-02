import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { agentJournalItemPosition } from './agent-session-journal-position'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import type { NativeChatMessage } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import { structuredAgentSessionSendBodyFingerprint } from './structured-agent-session-mutation'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

export type StructuredAgentSessionMessageProjectionOptions = {
  /** Draw a message the host accepted and then rejected where the host recorded it, as not sent.
   *  Off for a client that hands such a message back to its composer instead. */
  rejectedInPlace: boolean
}

const outboxBodyFingerprints = new WeakMap<AgentJournalMessageItem, string>()

function outboxBodyFingerprint(entry: StructuredAgentSessionOutboxEntry): string {
  let fingerprint = outboxBodyFingerprints.get(entry.body)
  if (fingerprint === undefined) {
    fingerprint = structuredAgentSessionSendBodyFingerprint(entry.sessionId, entry.body)
    outboxBodyFingerprints.set(entry.body, fingerprint)
  }
  return fingerprint
}

/**
 * The rejected submissions the host's history shows in place, by item id. A withdrawn one went
 * back to its sender; one the outbox still draws is drawn once, by the outbox; and one with a later
 * copy of the same body is superseded by it — earlier builds resent a rejected message under a new
 * id, so without this an update would surface every resent copy.
 */
function rejectedShownInPlace(
  submissions: readonly AgentJournalSubmission[],
  outbox: readonly StructuredAgentSessionOutboxEntry[]
): Set<string> {
  const shown = new Set<string>()
  const outboxIds = new Set(outbox.map((entry) => entry.clientMessageId))
  // Submissions arrive ordered by submission time. A withdrawn copy is hidden too, so it
  // supersedes nothing.
  const lastCopy = new Map<string, number>()
  for (const [index, submission] of submissions.entries()) {
    if (!dispatchWasWithdrawn(submission)) {
      lastCopy.set(submission.payloadFingerprint, index)
    }
  }
  for (const [index, submission] of submissions.entries()) {
    if (
      submission.dispatchState !== 'rejected' ||
      dispatchWasWithdrawn(submission) ||
      outboxIds.has(submission.clientMessageId) ||
      (lastCopy.get(submission.payloadFingerprint) ?? index) > index ||
      outbox.some((entry) => outboxBodyFingerprint(entry) === submission.payloadFingerprint)
    ) {
      continue
    }
    shown.add(agentJournalSubmissionKey(submission.clientMessageId))
  }
  return shown
}

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  options: StructuredAgentSessionMessageProjectionOptions,
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions)
  // Refused sends are ledger evidence, not conversation history, unless drawn in place as not sent.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const inPlace = options.rejectedInPlace
    ? rejectedShownInPlace(submissions, optimistic)
    : new Set<string>()
  const visibleItems: AgentJournalRenderItem[] = []
  const unsentItems: AgentJournalRenderItem[] = []
  const refused = new Map<string, AgentJournalRenderItem>()
  for (const item of items) {
    if (inPlace.has(item.itemId)) {
      unsentItems.push(item)
    } else if (rejected.has(item.itemId)) {
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
    // In no turn, like the outbox's not-sent rows; the journal position keeps their place.
    ...projectItems(unsentItems).map((message) => ({ ...message, unsent: true as const })),
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
            : {}),
          // A send the journal recorded before refusing it keeps its place there.
          ...(recorded ? { journalPosition: agentJournalItemPosition(recorded) } : {})
        }
      })
  ]
}
