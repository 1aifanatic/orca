// How a dispatch row, or the provider's echo of a send, moves a submission's delivery state.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

export function applyJournalDispatchRow(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const submission = state.submissions.get(row.clientMessageId)
  if (!submission) {
    return
  }
  // `rejected` is terminal; a late `unknown` must not reopen a settled answer.
  if (submission.dispatchState === 'rejected' || submission.dispatchState === 'accepted') {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = row.state
  submission.providerItemId = row.providerItemId
  submission.reason = row.reason
  submission.resolvedAt = row.state === 'pending' ? null : row.ts
  if (row.state === 'pending') {
    submission.handedOverAt = row.ts
  }
  if (row.recovered) {
    submission.recovered = row.recovered
  } else {
    delete submission.recovered
  }
  if (row.state !== 'accepted' || !row.providerItemId) {
    return
  }
  state.aliases.set(row.providerItemId, agentJournalSubmissionKey(row.clientMessageId))
  state.receipts.set(row.clientMessageId, {
    clientMessageId: row.clientMessageId,
    providerItemId: row.providerItemId,
    cursor: { epoch: row.epoch, sequence: row.seq },
    acceptedAt: row.ts
  })
}

export function acceptJournalSubmissionFromProviderItem(
  state: JournalReducerState,
  providerItemId: string,
  resolvedItemId: string,
  row: Pick<JournalRow, 'epoch' | 'seq' | 'fence' | 'ts'>
): void {
  if (providerItemId === resolvedItemId) {
    return
  }
  const submission = [...state.submissions.values()].find(
    (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === resolvedItemId
  )
  if (
    !submission ||
    submission.dispatchState === 'accepted' ||
    submission.dispatchState === 'rejected'
  ) {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = 'accepted'
  submission.providerItemId = providerItemId
  submission.reason = null
  submission.resolvedAt = row.ts
  delete submission.recovered
  state.receipts.set(submission.clientMessageId, {
    clientMessageId: submission.clientMessageId,
    providerItemId,
    cursor: { epoch: row.epoch, sequence: row.seq },
    acceptedAt: row.ts
  })
}
