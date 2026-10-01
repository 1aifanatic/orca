// The one writer of a failed agent start: the delivery loop, which records it on the message the
// start was for and on any message handed to that start's child, which took nothing. Each goes back
// in the queue with its next try booked, or, out of tries, ends `rejected` in the same words. The
// messages behind it go on meanwhile.

import {
  isSubmissionRejectionFact,
  readAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { structuredAgentSessionStartRetryAt } from '../../../shared/structured-agent-session-start-retry'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  endStructuredAgentSessionCommandStartFailure,
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
} from './structured-agent-session-command-turn'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'

type StartFailureJournal = Pick<
  AgentSessionJournal,
  'submissions' | 'itemBody' | 'resolveDispatch' | 'appendLifecycleBatch'
>

export type StructuredAgentSessionStartAttemptFailure = {
  cause: StructuredAgentSessionStartFailureCause
  /** The child whose start failed; null when none was published. */
  generation: string | null
}

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

/**
 * Records `failure` on each of `clientMessageIds` still waiting on it: queued, or handed to the
 * child whose start failed. A message that Stop withdrew meanwhile is left alone.
 */
export async function recordStructuredAgentSessionStartAttemptFailure(
  ctx: {
    journal: StartFailureJournal
    fence: number
    record: AgentSessionRecord | null
    now: () => number
  },
  failure: StructuredAgentSessionStartAttemptFailure,
  clientMessageIds: readonly string[]
): Promise<void> {
  for (const clientMessageId of new Set(clientMessageIds)) {
    const submission = ctx.journal
      .submissions()
      .find((entry) => entry.clientMessageId === clientMessageId)
    if (submission?.dispatchState !== 'pending') {
      continue
    }
    const words = structuredAgentSessionStartFailure(
      failure.cause,
      startFailureWordsContext(ctx.journal, ctx.record, clientMessageId)
    )
    const nextAttemptAt = structuredAgentSessionStartRetryAt(
      words.rejection,
      (submission.startFailure?.attempts ?? 0) + 1,
      ctx.now()
    )
    await ctx.journal.resolveDispatch(
      nextAttemptAt === null
        ? { clientMessageId, state: 'rejected', ...words, fence: ctx.fence }
        : {
            clientMessageId,
            state: 'pending',
            startFailure: {
              reason: words.reason,
              rejection: words.rejection,
              nextAttemptAt,
              ...(failure.generation ? { generation: failure.generation } : {})
            },
            fence: ctx.fence
          }
    )
    // A command opens its turn at handover; that turn is over, and its message says why.
    await endStructuredAgentSessionCommandStartFailure(
      { journal: ctx.journal, fence: ctx.fence, now: ctx.now },
      clientMessageId
    )
  }
}

/** What a queued message is rejected with when it cannot wait any longer — the chat closed, Orca
 *  quit or restarted: the start failure it was waiting out, else `fallback`. */
export function leftoverRejection(
  journal: Pick<AgentSessionJournal, 'itemBody'>,
  record: AgentSessionRecord | null,
  fallback: AgentJournalDispatchRejection
): (submission: AgentJournalSubmission) => AgentJournalDispatchRejection {
  return (submission) => {
    const fact = readAgentSessionFailureFact(submission.startFailure?.rejection)
    return fact && isSubmissionRejectionFact(fact)
      ? agentSessionFailureWords(fact, {
          ...startFailureWordsContext(journal, record, submission.clientMessageId),
          surface: 'rejection'
        })
      : fallback
  }
}

/** The oldest queued message that may go now: not waiting out a failed start, or due again. Later
 *  messages overtake one that is waiting. */
export function nextDeliverableSubmission(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  now: number
): AgentJournalSubmission | undefined {
  let oldest: AgentJournalSubmission | undefined
  for (const submission of journal.submissions()) {
    if (
      isQueuedAgentJournalSubmission(submission) &&
      (submission.startFailure === undefined || submission.startFailure.nextAttemptAt <= now) &&
      (oldest === undefined || (submission.acceptedSequence ?? 0) < (oldest.acceptedSequence ?? 0))
    ) {
      oldest = submission
    }
  }
  return oldest
}

/** When the earliest message waiting out a failed start is due; null when none waits. */
export function earliestStartRetryAt(
  journal: Pick<AgentSessionJournal, 'submissions'> | undefined
): number | null {
  let earliest: number | null = null
  for (const submission of journal?.submissions() ?? []) {
    const due = isQueuedAgentJournalSubmission(submission)
      ? submission.startFailure?.nextAttemptAt
      : undefined
    if (due !== undefined && (earliest === null || due < earliest)) {
      earliest = due
    }
  }
  return earliest
}

/** The wake for that try: a cache of the journal's earliest due time, never what decides it. */
export function setStartRetryTimer(delayMs: number, run: () => void): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

/** Messages handed to a child under `fence` and not answered: if that child never proved its start,
 *  it took none of them. */
export function submissionsHandedToChild(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  fence: number
): string[] {
  return journal
    .submissions()
    .filter(
      (submission) =>
        submission.dispatchState === 'pending' &&
        submission.handedOverAt !== undefined &&
        submission.fence === fence
    )
    .map((submission) => submission.clientMessageId)
}
