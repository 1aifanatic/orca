// The one decision for whether a committed dispatch row changes a submission's
// effective delivery answer. The reducer folds rows through it and the queued
// draft's returned-transition hook fires through it, so the two can never
// disagree: a row the reducer ignores must not alter a draft.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../shared/structured-agent-session-dispatch-rejection'
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

/** A settled submission whose refusal returns the draft that produced it: a
 *  non-withdrawn rejection. A withdrawn send is the user's own Stop, not a
 *  refusal to surface. */
export function submissionRefusalReturnsDraft(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'reason'> | undefined
): boolean {
  return submission?.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
}

/** True when committing this row NEWLY settles the submission to a non-withdrawn
 *  rejection — the only transition that returns a consumed draft. */
export function journalDispatchRowNewlyRejects(
  submission: Pick<AgentJournalSubmission, 'dispatchState'> | undefined,
  row: Pick<JournalDispatchRow, 'state' | 'reason'>
): boolean {
  return (
    row.state === 'rejected' &&
    journalDispatchRowApplies(submission) &&
    submissionRefusalReturnsDraft({ dispatchState: 'rejected', reason: row.reason })
  )
}
