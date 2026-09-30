// Which of the structured chat's own messages say, on their row, that they did not go through.
//
// Derived from the outbox on every render and never stored: each failed or held message carries
// its own typed failure, so each row words its own reason. Read through the drain's own rule: while
// the queue is stopped, only the message it stopped on has a Retry; another's would wait unseen
// behind it. One waiting behind says nothing; a rejected message holds nothing up, so it keeps its
// words and gets its Retry once the queue moves.
//
// A message the host recorded and then rejected is worded from the journal's own fact, found by id;
// the message keeps only a smaller copy, read when its submission is not loaded. A submission the
// host records as rejected by a failed start whose row is loaded says only that it was not sent: the
// row already says why.

import { readAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import { structuredAgentSessionStartFailureRowStartKey } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  admitStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session-failure-words'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

/** The starts the chat's loaded start-failure rows are for. */
export function structuredAgentSessionStartFailureKeys(
  items: readonly AgentJournalRenderItem[]
): string[] {
  const keys: string[] = []
  for (const item of items) {
    const startKey =
      item.body.kind === 'status'
        ? structuredAgentSessionStartFailureRowStartKey(item.itemId)
        : null
    if (startKey) {
      keys.push(startKey)
    }
  }
  return keys
}

function deliveryNoticeText(
  entry: StructuredAgentSessionOutboxEntry,
  context: AgentSessionFailureWordsContext,
  recorded: AgentJournalSubmission | undefined,
  startFailureKeys: readonly string[]
): string {
  // A send attempted before a Stop and then interrupted may already be with the host.
  const attemptedAcrossStop =
    entry.outlivedStop === true && entry.lastAttemptAt !== null && !entry.lastFailure
  if (entry.state === 'unconfirmed' || attemptedAcrossStop) {
    return translate(
      'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
      'Message delivery is unconfirmed.'
    )
  }
  if (!entry.lastFailure) {
    return translate(
      'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
      'Message was not sent.'
    )
  }
  // Only the start's own writer names it, so an equal failure from elsewhere keeps its words.
  const startKey = recorded?.rejectedByStartKey
  if (entry.state === 'rejected' && startKey && startFailureKeys.includes(startKey)) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  const fact = readAgentSessionFailureFact(recorded?.rejection)
  return agentSessionWriteNoticeText(
    structuredAgentSessionAttemptFailureParts(entry.lastFailure, context, fact)
  )
}

/** Keyed by the message id the transcript renders each entry under. `blockedClientMessageId` is
 *  the entry a refusal stopped the queue on; `agentName` is the chat's agent, for the words. */
export function structuredAgentSessionDeliveryNotices(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  blockedClientMessageId: string | null,
  agentName: string,
  retry: (clientMessageId: string) => void,
  /** The journal's rows, whose rejected ones carry more of a rejection than the message keeps. */
  submissions: readonly AgentJournalSubmission[],
  /** The starts the loaded start-failure rows are for, from `structuredAgentSessionStartFailureKeys`. */
  startFailureKeys: readonly string[]
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const admission = admitStructuredAgentSessionOutboxEntry(outbox, blockedClientMessageId)
  const held = admission.state === 'blocked' ? admission.entry.clientMessageId : null
  const rejected = new Map(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => [submission.clientMessageId, submission])
  )
  const notices = new Map<string, NativeChatDeliveryNotice>()
  for (const entry of outbox) {
    if (entry.state === 'rejected' || entry.clientMessageId === held) {
      // Its own Retry is the step, so the words leave out sending again.
      const retryControl = held === null || entry.clientMessageId === held
      const text = deliveryNoticeText(
        entry,
        { agentName, retryControl },
        rejected.get(entry.clientMessageId),
        startFailureKeys
      )
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        retryControl ? { text, onRetry: () => retry(entry.clientMessageId) } : { text }
      )
    }
  }
  return notices
}
