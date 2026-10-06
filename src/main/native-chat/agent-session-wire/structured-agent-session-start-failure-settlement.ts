// The delivery loop's writer of a failed start: the one queued message the start was for. A message
// handed to a child that never proved its start is the handover's or the exit's to settle; each
// state has one writer, and `rejected` is terminal, so no message is failed twice.

import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isFailedStartRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { STRUCTURED_AGENT_SESSION_COMPACT_COMMAND } from './structured-agent-session-command-turn'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'

type StartFailureJournal = Pick<AgentSessionJournal, 'submissions' | 'itemBody' | 'resolveDispatch'>

/** Who the message's sentence names, and the command its own body sends, so the next step is to run
 *  that command again rather than to send a message. */
function startFailureWordsContext(
  journal: Pick<AgentSessionJournal, 'itemBody'>,
  record: AgentSessionRecord | null,
  clientMessageId: string
): AgentSessionFailureWordsContext {
  const body = journal.itemBody(agentJournalSubmissionKey(clientMessageId))
  const command =
    body?.kind === 'message' && body.command?.name === STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
      ? STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
      : undefined
  return {
    ...structuredAgentSessionFailureWordsContext(record),
    ...(command ? { command } : {})
  }
}

/** Whether the message is still accepted and not yet handed over. */
export function isStillQueued(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  clientMessageId: string
): boolean {
  const submission = journal
    .submissions()
    .find((entry) => entry.clientMessageId === clientMessageId)
  return submission !== undefined && isQueuedAgentJournalSubmission(submission)
}

/** Rejects the message a failed start was for. Writes nothing once it is no longer queued: Stop
 *  withdrew it, or another writer settled it. */
export async function rejectStructuredAgentSessionStartFailure(
  writer: { journal: StartFailureJournal; fence: number; record: AgentSessionRecord | null },
  cause: StructuredAgentSessionStartFailureCause,
  clientMessageId: string
): Promise<void> {
  if (!isStillQueued(writer.journal, clientMessageId)) {
    return
  }
  await writer.journal.resolveDispatch({
    clientMessageId,
    state: 'rejected',
    ...structuredAgentSessionStartFailure(
      cause,
      startFailureWordsContext(writer.journal, writer.record, clientMessageId)
    ),
    fence: writer.fence
  })
}

type FailedStartSubmission = Pick<
  AgentJournalSubmission,
  'dispatchState' | 'handoverRecorded' | 'handedOverAt'
> &
  Partial<Pick<AgentJournalSubmission, 'fence' | 'reason' | 'rejection'>>

/** Whether a message was rejected as the failed start of the child under `fence`. */
export function rejectedAsFailedStartAt(submission: FailedStartSubmission, fence: number): boolean {
  return (
    submission.dispatchState === 'rejected' &&
    submission.fence === fence &&
    isFailedStartRejection({ reason: submission.reason ?? null, rejection: submission.rejection })
  )
}

/** Whether a message says why a child that died starting under `fence` failed: a queued one, which
 *  the delivery loop rejects with it or starts again for, or one already rejected as that start. */
export function messageCarriesFailedStart(
  submissions: readonly FailedStartSubmission[],
  fence: number
): boolean {
  return submissions.some(
    (submission) =>
      isQueuedAgentJournalSubmission(submission) || rejectedAsFailedStartAt(submission, fence)
  )
}

export function oldestQueuedSubmission(
  journal: Pick<AgentSessionJournal, 'submissions'>
): AgentJournalSubmission | undefined {
  let oldest: AgentJournalSubmission | undefined
  for (const submission of journal.submissions()) {
    if (
      isQueuedAgentJournalSubmission(submission) &&
      (oldest === undefined || (submission.acceptedSequence ?? 0) < (oldest.acceptedSequence ?? 0))
    ) {
      oldest = submission
    }
  }
  return oldest
}
