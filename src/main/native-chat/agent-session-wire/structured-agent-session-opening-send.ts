// Whether a send ahead is still opening its own turn, so the next message waits for that turn.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { oldestQueuedSubmission } from './structured-agent-session-start-failure-row'

/** The queued message to hand over now: the oldest, unless a send ahead is still opening its turn
 *  (`structuredAgentSessionSendOpeningTurn`), when none is, and the commit that ends that wakes the
 *  delivery loop again. */
export function structuredAgentSessionNextHandover(
  session: Pick<StructuredAgentSessionHostSession, 'journal'>,
  fence: number
): ReturnType<typeof oldestQueuedSubmission> {
  return structuredAgentSessionSendOpeningTurn(session.journal, fence)
    ? undefined
    : oldestQueuedSubmission(session)
}

/**
 * A send this child was handed while no turn ran, still unsettled, with no turn record and no Stop
 * written since its handover. A message handed over now would join the turn that send is opening
 * (Codex steers it in once the turn opens, Claude folds it into the running cycle), yet its
 * handover row would be written before that turn exists, and so read as belonging to none. It
 * waits instead, and goes in as a steer once the turn opens. Every way the send stops opening — its
 * turn record, its echo, its refusal, a lost answer's doubt, its child's end — is a commit, which
 * wakes the delivery loop to read this again. So is a Stop, which releases it whatever became of
 * the send: what is sent after a Stop starts its own turn, never waiting on what the Stop left.
 */
export function structuredAgentSessionSendOpeningTurn(
  journal: Pick<AgentSessionJournal, 'submissions' | 'visitItemsWithLinkage' | 'stopMarks'>,
  fence: number
): boolean {
  const opening = new Set(
    journal
      .submissions()
      .flatMap((submission) =>
        submission.dispatchState === 'pending' &&
        submission.handedOverAt !== undefined &&
        submission.fence === fence
          ? [agentJournalSubmissionKey(submission.clientMessageId)]
          : []
      )
  )
  if (opening.size === 0) {
    return false
  }
  // Neither a turn opened nor a Stop since the handover: either ends the wait.
  let sinceOpenedOrStopped = journal.stopMarks.latest()?.sequence ?? -1
  const handedOverAt: number[] = []
  journal.visitItemsWithLinkage((itemId, sequence, body, linkage) => {
    if (opening.has(itemId) && linkage.turnScope?.kind === 'thread') {
      handedOverAt.push(sequence)
    }
    if (readAgentJournalTurn(body) && isRootAgentJournalItem(linkage)) {
      sinceOpenedOrStopped = Math.max(sinceOpenedOrStopped, sequence)
    }
  })
  return handedOverAt.some((sequence) => sequence > sinceOpenedOrStopped)
}
