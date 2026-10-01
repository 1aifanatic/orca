// A message this client did not send — one the host sent itself, such as a restart's continuation,
// or one another device sent — whose start failed for good. No outbox entry here shows it, so the
// chat shows it from the journal: an unsent message that says why, whose Retry, on a host that can,
// queues that same message again.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import {
  failedBeforeHandover,
  isRequeueableAgentJournalSubmission
} from './structured-agent-session-dispatch-rejection'

export function failedStartsSentElsewhere(
  submissions: readonly AgentJournalSubmission[],
  outbox: readonly Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId'>[]
): AgentJournalSubmission[] {
  const sentHere = new Set(outbox.map((entry) => entry.clientMessageId))
  return submissions.filter(
    (submission) =>
      !sentHere.has(submission.clientMessageId) &&
      // A queued card's message: the card shows it, and its own Retry is the card's.
      submission.queuedMessageId === undefined &&
      failedBeforeHandover(submission)
  )
}

/** Of those, the ones a Retry here queues again in place, by id: any no agent ever took. */
export function retryableFailedStartsSentElsewhere(
  submissions: readonly AgentJournalSubmission[],
  outbox: readonly Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId'>[]
): ReadonlySet<string> {
  return new Set(
    failedStartsSentElsewhere(submissions, outbox)
      .filter(isRequeueableAgentJournalSubmission)
      .map((submission) => submission.clientMessageId)
  )
}
