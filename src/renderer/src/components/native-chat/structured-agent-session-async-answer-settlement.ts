// How a structured async-question answer's outbox entry ended, by its clientMessageId. The
// journal and the outbox answer most dispositions; the moves that drop an entry with no row
// to read (a send answered accepted or queued, a Stop's withdrawal, the host queue taking it)
// or put it back in the queue (an owner change) record their outcome here first, so no
// disposition leaves the card's Send disabled.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session-queued-submission'
import type { NativeChatAsyncAnswerOutcome } from '../../../../shared/native-chat-async-question-answers'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { isStructuredAgentSessionAsyncAnswer } from '../../../../shared/structured-agent-session-outbox-origin'

const MAX_RECORDED = 128
const recorded = new Map<string, NativeChatAsyncAnswerOutcome>()

/** Records how async answers that `before` held and `after` dropped ended. */
export function recordDroppedStructuredAsyncAnswers(
  before: readonly StructuredAgentSessionOutboxEntry[],
  after: readonly StructuredAgentSessionOutboxEntry[],
  outcome: NativeChatAsyncAnswerOutcome
): void {
  const kept = new Set(after.map((entry) => entry.clientMessageId))
  for (const entry of before) {
    if (isStructuredAgentSessionAsyncAnswer(entry) && !kept.has(entry.clientMessageId)) {
      recorded.set(entry.clientMessageId, outcome)
    }
  }
  boundRecorded()
}

/** Records async answers an owner change sent back to the queue: whether the first send
 *  landed is unknown, so the card stops waiting even if the resend never goes out. */
export function recordInterruptedStructuredAsyncAnswers(
  before: readonly StructuredAgentSessionOutboxEntry[],
  after: readonly StructuredAgentSessionOutboxEntry[]
): void {
  const prior = new Map(before.map((entry) => [entry.clientMessageId, entry]))
  for (const entry of after) {
    const was = prior.get(entry.clientMessageId)
    if (
      isStructuredAgentSessionAsyncAnswer(entry) &&
      was?.state === 'dispatching' &&
      entry.state === 'queued'
    ) {
      recorded.set(entry.clientMessageId, 'unknown')
    }
  }
  boundRecorded()
}

// Bounded: an answer whose card is gone never reads its record.
function boundRecorded(): void {
  for (const id of recorded.keys()) {
    if (recorded.size <= MAX_RECORDED) {
      break
    }
    recorded.delete(id)
  }
}

export function forgetStructuredAsyncAnswer(clientMessageId: string): void {
  recorded.delete(clientMessageId)
}

function submissionOutcome(
  submission: AgentJournalSubmission
): NativeChatAsyncAnswerOutcome | null {
  if (submission.dispatchState === 'accepted') {
    return 'accepted'
  }
  if (submission.dispatchState === 'rejected') {
    return dispatchWasWithdrawn(submission) ? 'withdrawn' : 'rejected'
  }
  if (submission.dispatchState === 'unknown') {
    return 'unknown'
  }
  // A direct send awaiting the provider is still in flight; a held one is the host's now.
  return isQueuedAgentJournalSubmission(submission) ? 'queued' : null
}

/** The answer's outcome once it has one; null while it is still on its way. */
export function structuredAsyncAnswerOutcome(
  clientMessageId: string,
  sources: {
    outbox: readonly StructuredAgentSessionOutboxEntry[]
    submissions: readonly AgentJournalSubmission[]
    queuedMessageIds: readonly string[] | undefined
  }
): NativeChatAsyncAnswerOutcome | null {
  const submission = sources.submissions.find(
    (candidate) => candidate.clientMessageId === clientMessageId
  )
  if (submission) {
    return submissionOutcome(submission)
  }
  if (sources.queuedMessageIds?.includes(clientMessageId)) {
    return 'queued'
  }
  const entry = sources.outbox.find((candidate) => candidate.clientMessageId === clientMessageId)
  if (entry) {
    if (entry.state === 'rejected' || (entry.state === 'queued' && entry.lastFailure)) {
      return 'rejected'
    }
    if (entry.state === 'unconfirmed') {
      return 'unknown'
    }
    // An owner change's requeue, even if the entry has already gone out again.
    return recorded.get(clientMessageId) ?? null
  }
  return recorded.get(clientMessageId) ?? null
}
