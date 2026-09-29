import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'

/** Whether only the user's Retry sends this entry again: a refused one, the one the drain stopped
 *  on, one a Stop outlived, or one in doubt the unconfirmed probe leaves alone. `NativeChatDeliveryRetry` offers it. */
function awaitsStructuredAgentSessionRetry(
  entry: StructuredAgentSessionOutboxEntry,
  blockedClientMessageId: string | null
): boolean {
  return (
    entry.state === 'rejected' ||
    entry.clientMessageId === blockedClientMessageId ||
    entry.outlivedStop === true ||
    (entry.state === 'unconfirmed' && entry.retryAfterUnknownSubmittedAt !== null)
  )
}

function unsentStructuredAgentSessionOutboxEntry(
  submissions: readonly AgentJournalSubmission[],
  blockedClientMessageId: string | null
): (entry: StructuredAgentSessionOutboxEntry) => boolean {
  const held = handedOffQueuedMessageIds(submissions)
  for (const submission of submissions) {
    held.add(submission.clientMessageId)
  }
  return (entry) =>
    !held.has(entry.clientMessageId) &&
    !awaitsStructuredAgentSessionRetry(entry, blockedClientMessageId)
}

/** An issued mid-turn queue send whose answer is still out: `dispatching` or left in doubt as
 *  `unconfirmed`. The host may already hold it as a paused draft, so a local restore too would
 *  put the same text in two places. A `queued` entry never left, and a requeued refusal was
 *  answered, so both restore safely. `dispatching` is not only the in-flight id: a `pending`
 *  answer frees single-flight but leaves the entry `dispatching` until its journal row arrives. */
function issuedQueueDeliverySendAwaitingAnswer(entry: StructuredAgentSessionOutboxEntry): boolean {
  return (
    entry.delivery === 'queue-if-active' &&
    (entry.state === 'dispatching' || entry.state === 'unconfirmed')
  )
}

/** A queue send whose answer is out when a Stop lands is marked, so no later unknown answer
 *  leaves it to the probe: resent onto the session the user just stopped, it would start a turn
 *  if the host never got the first attempt. */
function markedOutlivingStop(
  entry: StructuredAgentSessionOutboxEntry
): StructuredAgentSessionOutboxEntry {
  return issuedQueueDeliverySendAwaitingAnswer(entry) && entry.outlivedStop !== true
    ? { ...entry, outlivedStop: true }
    : entry
}

/**
 * What a Stop leaves in the outbox: nothing the journal does not already hold may go out after it,
 * so every such entry goes, as a message the host withdraws leaves the chat. The send on its way
 * stays: it reaches the host ahead of the Stop, and it comes back from the host's answer, since
 * the agent may already have it. One waiting on Retry keeps it, and so does an issued queue send
 * whose answer is out (a queued receipt retires it against the published card; a withdrawn
 * submission restores it from the journal); one in doubt waits for Retry from then on.
 */
export function withdrawUnsentStructuredAgentSessionOutboxEntries(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  blockedClientMessageId: string | null,
  inFlightClientMessageId: string | null
): StructuredAgentSessionOutboxEntry[] {
  const unsent = unsentStructuredAgentSessionOutboxEntry(submissions, blockedClientMessageId)
  return entries
    .filter(
      (entry) =>
        entry.clientMessageId === inFlightClientMessageId ||
        !unsent(entry) ||
        issuedQueueDeliverySendAwaitingAnswer(entry)
    )
    .map(markedOutlivingStop)
}

/** Whether a Stop has something here to withdraw: a message that would still go out on its own. */
export function hasUnsentStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  blockedClientMessageId: string | null
): boolean {
  return entries.some(unsentStructuredAgentSessionOutboxEntry(submissions, blockedClientMessageId))
}
