// The writer of a failed start's record: the message it failed, rejected, and its row keyed by that
// message, in one write, so a client that hides rejected messages still sees why. The delivery loop
// writes it for the queued message a start was for, the handover for the message it was handing
// over; the exit writes one row keyed by the start for the handed messages it rejected, or for a
// start no message carries. Each message state has one writer, and `rejected` is terminal, so no
// message is failed twice.

import type {
  AgentJournalDispatchRejection,
  AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isFailedStartOrHostFault } from '../../../shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../shared/structured-agent-session-start-failure-row-key'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionMessageCommand } from './structured-agent-session-command-turn'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'

type StartFailureJournal = Pick<
  AgentSessionJournal,
  'submissions' | 'itemBody' | 'appendLifecycleBatch'
>

/** A failed start's row in the chat: an error row keyed by its message (or by the start, from the
 *  exit), repeating the message's sentence, so the reason outlives any client that hides it. */
export function structuredAgentSessionStartFailureRow(
  startKey: string,
  words: AgentJournalDispatchRejection
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: structuredAgentSessionStartFailureRowIdentity(startKey),
    body: { kind: 'status', text: words.reason, tone: 'error', failure: words.rejection },
    // A start that failed opened no turn.
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

/** Rejects a message its start failed and writes that start's row with it, keyed by the message, in
 *  one append. Writes nothing once `which` no longer holds for it: Stop withdrew it, or another
 *  writer settled it. */
export async function rejectWithStartFailureRow(
  journal: Pick<AgentSessionJournal, 'appendLifecycleBatch'>,
  input: {
    clientMessageId: string
    words: AgentJournalDispatchRejection
    fence: number
    which: (submission: AgentJournalSubmission) => boolean
  }
): Promise<void> {
  const { clientMessageId, words, fence, which } = input
  await journal.appendLifecycleBatch({
    settlementId: `start-failure:${clientMessageId}`,
    fence,
    recovered: true,
    mutations: [structuredAgentSessionStartFailureRow(clientMessageId, words)],
    rejects: { clientMessageId, ...words, which }
  })
}

/** Who the message's sentence names, and the command its own body sends. */
function startFailureWordsContext(
  journal: Pick<AgentSessionJournal, 'itemBody'>,
  record: AgentSessionRecord | null,
  clientMessageId: string
): AgentSessionFailureWordsContext {
  const command = structuredAgentSessionMessageCommand(journal, clientMessageId)
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

/** The delivery loop's record of the queued message a failed start was for. */
export function rejectStructuredAgentSessionStartFailure(
  writer: { journal: StartFailureJournal; fence: number; record: AgentSessionRecord | null },
  cause: StructuredAgentSessionStartFailureCause,
  clientMessageId: string
): Promise<void> {
  return rejectWithStartFailureRow(writer.journal, {
    clientMessageId,
    words: structuredAgentSessionStartFailure(
      cause,
      startFailureWordsContext(writer.journal, writer.record, clientMessageId)
    ),
    fence: writer.fence,
    which: isQueuedAgentJournalSubmission
  })
}

type FailedStartSubmission = Pick<AgentJournalSubmission, 'dispatchState'> &
  Partial<Pick<AgentJournalSubmission, 'fence' | 'reason' | 'rejection'>>

/** Whether a message was rejected as the failed start of the child under `fence`. */
export function rejectedAsFailedStartAt(submission: FailedStartSubmission, fence: number): boolean {
  return (
    submission.dispatchState === 'rejected' &&
    submission.fence === fence &&
    isFailedStartOrHostFault({ reason: submission.reason ?? null, rejection: submission.rejection })
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
