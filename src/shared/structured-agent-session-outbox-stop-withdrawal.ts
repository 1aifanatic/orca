import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'

/** Whether only the user's Retry sends this entry again: a refused one, the one the drain stopped
 *  on, or one in doubt the unconfirmed probe leaves alone. `NativeChatDeliveryRetry` offers it. */
function awaitsStructuredAgentSessionRetry(
  entry: StructuredAgentSessionOutboxEntry,
  blockedClientMessageId: string | null
): boolean {
  return (
    entry.state === 'rejected' ||
    entry.clientMessageId === blockedClientMessageId ||
    (entry.state === 'unconfirmed' && entry.retryAfterUnknownSubmittedAt !== null)
  )
}

function unsentStructuredAgentSessionOutboxEntry(
  submissions: readonly AgentJournalSubmission[],
  blockedClientMessageId: string | null
): (entry: StructuredAgentSessionOutboxEntry) => boolean {
  const held = new Set(submissions.map((submission) => submission.clientMessageId))
  return (entry) =>
    !held.has(entry.clientMessageId) &&
    !awaitsStructuredAgentSessionRetry(entry, blockedClientMessageId)
}

/**
 * What a Stop leaves in the outbox: nothing the journal does not already hold may go out after it,
 * so every such entry goes, as a message the host withdraws leaves the chat. A send still on its way
 * reaches the host ahead of the Stop, which withdraws it there. One waiting on Retry keeps it.
 */
export function withdrawUnsentStructuredAgentSessionOutboxEntries(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  blockedClientMessageId: string | null
): StructuredAgentSessionOutboxEntry[] {
  const unsent = unsentStructuredAgentSessionOutboxEntry(submissions, blockedClientMessageId)
  return entries.filter((entry) => !unsent(entry))
}

/** Whether a Stop has something here to withdraw: a message that would still go out on its own. */
export function hasUnsentStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  blockedClientMessageId: string | null
): boolean {
  return entries.some(unsentStructuredAgentSessionOutboxEntry(submissions, blockedClientMessageId))
}
