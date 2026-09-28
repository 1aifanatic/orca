import {
  isSubmissionRejectionFact,
  readAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../shared/structured-agent-session-start-failure-row-key'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionStartFailureWords } from './structured-agent-session-failure-text'

/** A start that failed, keyed like its row, in the words `structuredAgentSessionStartFailure` gave. */
export type StructuredAgentSessionStartFailure = StructuredAgentSessionStartFailureWords & {
  startKey: string | null
}

/**
 * The one row a start that failed leaves in the chat, whoever saw it fail: an error row, so the
 * reason outlives any error strip. Keyed by the start — the child's generation, or the oldest
 * message it was for when no child was ever published — so a second report of the same failure
 * lands on the same row instead of adding one.
 */
export function structuredAgentSessionStartFailureRow(
  startKey: string,
  words: StructuredAgentSessionStartFailureWords
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: structuredAgentSessionStartFailureRowIdentity(startKey),
    // The row repeats the sentence the start's rejected messages carry.
    body: { kind: 'status', text: words.reason, tone: 'error', failure: words.rejection }
  }
}

export function structuredAgentSessionStartFailureRowItemId(startKey: string): string {
  return agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(startKey))
}

/**
 * What a failed start rejects its messages with, naming the start. Once its row is written, the
 * row's words win: a later report of the same start never puts other words beside it, and never
 * rewrites the row (`written`). A written row whose fact this build cannot read names no start.
 */
export function structuredAgentSessionStartFailureRejection(
  row: AgentJournalItemBody | null | undefined,
  startKey: string,
  words: StructuredAgentSessionStartFailureWords
): { words: StructuredAgentSessionStartFailureWords; written: boolean } {
  if (!row) {
    return { words: { ...words, rejection: { ...words.rejection, startKey } }, written: false }
  }
  if (row.kind !== 'status' || !row.failure) {
    return { words, written: true }
  }
  const fact = readAgentSessionFailureFact(row.failure)
  if (!fact || !isSubmissionRejectionFact(fact)) {
    return { words, written: true }
  }
  return { words: { reason: row.text, rejection: { ...fact, startKey } }, written: true }
}

/**
 * A start the delivery loop needed and did not get: the start's row, and every message it was for
 * rejected with the same words — each queued one, and `handedOver`, the one handed to a child that
 * could not take it. Writes nothing when neither is left: a start whose messages Stop withdrew did
 * not fail anyone.
 */
export async function recordStructuredAgentSessionStartFailure(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> & { fence: number },
  failure: StructuredAgentSessionStartFailure,
  handedOver?: string
): Promise<void> {
  const oldest = handedOver ?? oldestQueuedSubmission(session)?.clientMessageId
  if (!oldest) {
    return
  }
  const startKey = failure.startKey ?? oldest
  // The row and each message it rejects name this start, so a reader pairs them by identity.
  const { words, written } = structuredAgentSessionStartFailureRejection(
    session.journal.itemBody(structuredAgentSessionStartFailureRowItemId(startKey)),
    startKey,
    { reason: failure.reason, rejection: failure.rejection }
  )
  if (!written) {
    await session.journal.appendLifecycleBatch({
      settlementId: `start-failure:${startKey}`,
      fence: session.fence,
      recovered: true,
      mutations: [structuredAgentSessionStartFailureRow(startKey, words)]
    })
  }
  if (handedOver) {
    await session.journal.resolveDispatch({
      clientMessageId: handedOver,
      state: 'rejected',
      ...words,
      fence: session.fence
    })
  }
  await session.journal.rejectQueuedSubmissions(session.fence, words)
}

export function oldestQueuedSubmission(
  session: Pick<StructuredAgentSessionHostSession, 'journal'>
): ReturnType<StructuredAgentSessionHostSession['journal']['submissions']>[number] | undefined {
  let oldest: ReturnType<typeof oldestQueuedSubmission>
  for (const submission of session.journal.submissions()) {
    if (
      isQueuedAgentJournalSubmission(submission) &&
      (oldest === undefined || (submission.acceptedSequence ?? 0) < (oldest.acceptedSequence ?? 0))
    ) {
      oldest = submission
    }
  }
  return oldest
}
