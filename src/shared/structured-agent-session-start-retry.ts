// When a message whose agent start was refused before it ran is tried again. Such a refusal usually
// has an end — an account switch, a lease being settled — so the message is owed a few more tries
// before it is the person's to act on.

import type { AgentSessionFailureFact } from './agent-session-failure'
import { isResumableStartFailure } from './agent-session-start-resumability'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'

/** The wait after the first, second and third failed start; a fourth is terminal. */
export const STRUCTURED_AGENT_SESSION_START_RETRY_DELAYS_MS: readonly number[] = [
  15_000, 60_000, 300_000
]

/** When the next start is due after `attempts` failed ones; null when the message is done trying.
 *  A start that ran and failed here, or a failure only the person can clear — signed out, a
 *  setting to fix, a new chat to start — is done at once, with the person's Retry. */
export function structuredAgentSessionStartRetryAt(
  fact: Pick<AgentSessionFailureFact, 'kind' | 'refusal'>,
  attempts: number,
  failedAt: number
): number | null {
  if (!isResumableStartFailure(fact)) {
    return null
  }
  const delay = STRUCTURED_AGENT_SESSION_START_RETRY_DELAYS_MS[attempts - 1]
  return delay === undefined ? null : failedAt + delay
}

/** A queued message waiting out a refused start: nothing runs for it until its next try. */
export function isRetryingStructuredAgentSessionStart(
  submission: Pick<
    AgentJournalSubmission,
    'handoverRecorded' | 'dispatchState' | 'handedOverAt' | 'startRetry'
  >
): boolean {
  return submission.startRetry !== undefined && isQueuedAgentJournalSubmission(submission)
}
