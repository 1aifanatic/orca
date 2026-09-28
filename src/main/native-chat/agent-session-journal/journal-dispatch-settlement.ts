// The one decision for whether a committed dispatch row changes a submission's
// effective delivery answer. The reducer folds rows through it and the queued
// draft's returned-transition hook fires through it, so the two can never
// disagree: a row the reducer ignores must not alter a draft.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { JournalDispatchRow } from './journal-row-schema'

/** `rejected` and `accepted` are terminal; a late row for an absent or settled
 *  submission must not reopen the answer. */
export function journalDispatchRowApplies(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined
): boolean {
  return (
    submission !== undefined &&
    submission.dispatchState !== 'rejected' &&
    submission.dispatchState !== 'accepted'
  )
}

/** A consumed draft's submission that settled `rejected` — refused, or withdrawn
 *  by a Stop before it reached the agent — returns the draft: its text has no
 *  other holder once it left the sender's outbox as a draft. The stored reason
 *  tells the two apart (`dispatchWasWithdrawn`). */
export function submissionRejectionReturnsDraft(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined
): boolean {
  return submission?.dispatchState === 'rejected'
}

/** True when committing this row NEWLY settles the submission to `rejected` —
 *  the only transition that returns a consumed draft. */
export function journalDispatchRowNewlyRejects(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined,
  row: Pick<JournalDispatchRow, 'state'>
): boolean {
  return row.state === 'rejected' && journalDispatchRowApplies(submission)
}
