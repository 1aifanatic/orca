// A message no outbox entry here shows — one the host sent itself, such as a restart's
// continuation, one another device sent, or one this client let go once the host recorded it —
// that never reached its agent. The chat shows it from the journal as an unsent message.
// One whose start failed for good, on a host that can queue it again, says why, and its Retry
// queues that same message again. One the agent's own history later showed it never got says
// only that it was not sent, with no Retry: the host cannot queue it again.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import {
  classifyDispatchRejection,
  failedBeforeHandover
} from './structured-agent-session-dispatch-rejection'

type SentHere = readonly Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId'>[]

export function failedStartsSentElsewhere(
  submissions: readonly AgentJournalSubmission[],
  outbox: SentHere
): AgentJournalSubmission[] {
  return unsentElsewhere(submissions, outbox, failedBeforeHandover)
}

export function undeliveredSentElsewhere(
  submissions: readonly AgentJournalSubmission[],
  outbox: SentHere
): AgentJournalSubmission[] {
  return unsentElsewhere(
    submissions,
    outbox,
    (submission) =>
      submission.dispatchState === 'rejected' &&
      classifyDispatchRejection(submission).kind === 'notDelivered'
  )
}

function unsentElsewhere(
  submissions: readonly AgentJournalSubmission[],
  outbox: SentHere,
  unsent: (submission: AgentJournalSubmission) => boolean
): AgentJournalSubmission[] {
  const sentHere = new Set(outbox.map((entry) => entry.clientMessageId))
  return submissions.filter(
    (submission) =>
      !sentHere.has(submission.clientMessageId) &&
      // A queued card's message: the card shows it, and its own Retry is the card's.
      submission.queuedMessageId === undefined &&
      unsent(submission) &&
      !sentAgainSince(submission, submissions)
  )
}

/** The same words went through since, as a message of their own: a Retry that sent a new copy
 *  under a new id. A copy's body is the original's, so its body-only fingerprint matches. */
function sentAgainSince(
  original: AgentJournalSubmission,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  return submissions.some(
    (later) =>
      later.clientMessageId !== original.clientMessageId &&
      later.payloadFingerprint === original.payloadFingerprint &&
      later.submittedAt > original.submittedAt &&
      (later.dispatchState === 'accepted' || later.handedOverAt !== undefined)
  )
}
