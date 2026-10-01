// How a `dispatch` row settles its submission. Field by field, so a key the row gains must be
// copied here to reach any reader.

import {
  readAgentSessionFailureFact,
  type UnreadAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isFailedStartRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import type { JournalReducerState } from './journal-reducer'
import { notePersonTurnAccepted, placeHandedOverMessage } from './journal-submission-fold'
import type { JournalRow, JournalStartRetryRecord } from './journal-row-schema'

export function applyJournalDispatchRow(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const submission = state.submissions.get(row.clientMessageId)
  // Shared with the queued-draft returned hook: a row ignored here must not alter a draft.
  if (!submission || !journalDispatchRowApplies(submission)) {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = row.state
  submission.providerItemId = row.providerItemId
  submission.reason = row.reason
  const rejection = row.state === 'rejected' ? readStoredRejectionFact(row.rejection) : undefined
  if (rejection) {
    submission.rejection = rejection
  } else {
    delete submission.rejection
  }
  // A failed start's rejection proves its child took nothing it was handed: never handed over.
  if (rejection && isFailedStartRejection({ reason: row.reason, rejection })) {
    delete submission.handedOverAt
  }
  submission.resolvedAt = row.state === 'pending' ? null : row.ts
  const startRetry = row.state === 'pending' ? readStoredStartRetry(row.startRetry) : undefined
  if (startRetry) {
    // Still queued, its start refused before it ran: each refusal is one more attempt. Only a queued
    // message is written this way; nothing handed over waits for another start.
    submission.startRetry = {
      attempts: (submission.startRetry?.attempts ?? 0) + 1,
      ...startRetry,
      failedAt: row.ts
    }
  } else {
    delete submission.startRetry
  }
  if (row.state === 'pending' && !startRetry) {
    submission.handedOverAt = row.ts
    placeHandedOverMessage(state, submission, row)
  }
  if (row.recovered) {
    submission.recovered = row.recovered
  } else {
    delete submission.recovered
  }
  if (row.state === 'accepted') {
    notePersonTurnAccepted(state, submission)
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

/** A stored rejection fact, read where it can be placed; a kind it cannot place is kept as
 *  written, so the classifier still knows a fact was there without this build claiming what it
 *  says. Shared with the queued-draft table, whose returned card mirrors its submission. */
export function readStoredRejectionFact(value: unknown): UnreadAgentSessionFailureFact | undefined {
  return readAgentSessionFailureFact(value) ?? unreadFailureFact(value)
}

function unreadFailureFact(value: unknown): UnreadAgentSessionFailureFact | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    value.kind
    ? { kind: value.kind }
    : undefined
}

/** A failed start as its row recorded it; undefined when anything it needs is malformed. */
function readStoredStartRetry(value: unknown): JournalStartRetryRecord | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const reason = 'reason' in value ? value.reason : undefined
  const rejection = readAgentSessionFailureFact('rejection' in value ? value.rejection : undefined)
  const nextAttemptAt = 'nextAttemptAt' in value ? value.nextAttemptAt : undefined
  if (
    typeof reason !== 'string' ||
    !rejection ||
    typeof nextAttemptAt !== 'number' ||
    !Number.isFinite(nextAttemptAt)
  ) {
    return undefined
  }
  return {
    reason,
    rejection,
    nextAttemptAt
  }
}
