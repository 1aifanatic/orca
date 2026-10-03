// Which unanswered sends a dying Codex child takes with it as never sent, read from the journal at
// the settlement that lands, so a retried wind-down reads the same rows.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentType } from '../../../shared/agent-status-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** What the derivation reads; absent members (a narrow double) withdraw nothing. */
export type UnopenedSendJournal = {
  agent?: AgentType
  queuedMessages?: Pick<AgentSessionJournal['queuedMessages'], 'userStopInForce'>
  snapshot: () => Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
  submissions?: () => (Pick<
    AgentJournalSubmission,
    | 'clientMessageId'
    | 'dispatchState'
    | 'recovered'
    | 'handoverRecorded'
    | 'handedOverAt'
    | 'acceptedSequence'
  > &
    Partial<Pick<AgentJournalSubmission, 'submittedAt'>>)[]
  resolveDispatch?: AgentSessionJournal['resolveDispatch']
}

/**
 * Withdraws the sends a Codex child left unanswered when a person's Stop, in force since they were
 * sent, ends it and no turn was open for them: none runs, was written after the send, or ended
 * after it was handed over. Codex records a prompt only once its turn starts (core
 * tasks/regular.rs:50, session/turn.rs:886-902), so they never ran. A send steered into an open
 * turn may have been recorded there, so it, and any other end, stays in doubt.
 */
export async function withdrawCodexSendsNoTurnOpenedFor(
  journal: UnopenedSendJournal,
  fence: number
): Promise<void> {
  const stop = journal.agent === 'codex' ? journal.queuedMessages?.userStopInForce() : null
  if (!stop || !journal.submissions || !journal.resolveDispatch) {
    return
  }
  const turns = journal.snapshot().items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn
      ? [
          {
            running: turn.state === 'running',
            sequence: item.sequence,
            completedAt: turn.completedAt ?? 0
          }
        ]
      : []
  })
  const opened = (acceptedSequence: number, sentAt: number): boolean =>
    turns.some(
      (turn) => turn.running || turn.sequence > acceptedSequence || turn.completedAt >= sentAt
    )
  const unopened = journal
    .submissions()
    .filter(
      (entry) =>
        !isQueuedAgentJournalSubmission(entry) &&
        (entry.dispatchState === 'pending' ||
          (entry.dispatchState === 'unknown' && entry.recovered !== true)) &&
        entry.acceptedSequence !== undefined &&
        entry.acceptedSequence < stop.sequence &&
        !opened(entry.acceptedSequence, entry.handedOverAt ?? entry.submittedAt ?? 0)
    )
  const withdrawn = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
    surface: 'rejection'
  })
  for (const entry of unopened) {
    await journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'rejected',
      ...withdrawn,
      fence,
      recovered: true
    })
  }
}
