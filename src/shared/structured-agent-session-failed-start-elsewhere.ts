// A message this client did not send — one the host sent itself, such as a restart's continuation,
// or one another device sent — whose start failed for good. No outbox entry here shows it, so the
// chat shows it from the journal: an unsent message that says why.

import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import {
  classifyDispatchRejection,
  isFailedStartRejection
} from './structured-agent-session-dispatch-rejection'

export function failedStartsSentElsewhere(
  submissions: readonly AgentJournalSubmission[],
  outbox: readonly Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId'>[]
): AgentJournalSubmission[] {
  const sentHere = new Set(outbox.map((entry) => entry.clientMessageId))
  // A Retry's message stands for the one it sends again, wherever it was sent from.
  const retried = new Set(submissions.flatMap((submission) => submission.retries ?? []))
  return submissions.filter(
    (submission) =>
      submission.dispatchState === 'rejected' &&
      !sentHere.has(submission.clientMessageId) &&
      !retried.has(submission.clientMessageId) &&
      // Orca's own fault on the way to a start is one the start's writer records too.
      (isFailedStartRejection(submission) ||
        classifyDispatchRejection(submission).kind === 'hostFault')
  )
}

/** What a Retry here sends again for each such message, by id: its words, when that is all it
 *  holds. One with images is its sender's to send again: their files are not on this client. */
export function resendableFailedStartsSentElsewhere(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  outbox: readonly Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId'>[]
): ReadonlyMap<string, string> {
  const failed = new Map(
    failedStartsSentElsewhere(submissions, outbox).map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      submission.clientMessageId
    ])
  )
  const resendable = new Map<string, string>()
  if (failed.size === 0) {
    return resendable
  }
  for (const item of items) {
    const clientMessageId = failed.get(item.itemId)
    const { body } = item
    if (
      clientMessageId !== undefined &&
      body.kind === 'message' &&
      body.blocks.every((block) => block.type === 'text')
    ) {
      resendable.set(
        clientMessageId,
        body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
      )
    }
  }
  return resendable
}
