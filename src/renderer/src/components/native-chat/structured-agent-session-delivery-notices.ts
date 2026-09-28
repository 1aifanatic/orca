// Which of the structured chat's own messages say, on their row, that they did not go through.
//
// Derived from the outbox on every render and never stored: each failed or held message carries
// its own typed failure, so each row words its own reason. Read through the drain's own rule: while
// the queue is stopped, only the message it stopped on has a Retry; another's would wait unseen
// behind it. One waiting behind says nothing; a rejected message holds nothing up, so it keeps its
// words and gets its Retry once the queue moves.

import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import {
  admitStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session-failure-words'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

function deliveryNoticeText(
  entry: StructuredAgentSessionOutboxEntry,
  context: AgentSessionFailureWordsContext
): string {
  if (entry.state === 'unconfirmed') {
    return translate(
      'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
      'Message delivery is unconfirmed.'
    )
  }
  return entry.lastFailure
    ? agentSessionWriteNoticeText(
        structuredAgentSessionAttemptFailureParts(entry.lastFailure, context)
      )
    : translate(
        'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
        'Message was not sent.'
      )
}

/** Keyed by the message id the transcript renders each entry under. `blockedClientMessageId` is
 *  the entry a refusal stopped the queue on; `agentName` is the chat's agent, for the words. */
export function structuredAgentSessionDeliveryNotices(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  blockedClientMessageId: string | null,
  agentName: string,
  retry: (clientMessageId: string) => void
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const admission = admitStructuredAgentSessionOutboxEntry(outbox, blockedClientMessageId)
  const held = admission.state === 'blocked' ? admission.entry.clientMessageId : null
  const notices = new Map<string, NativeChatDeliveryNotice>()
  for (const entry of outbox) {
    if (entry.state === 'rejected' || entry.clientMessageId === held) {
      // Its own Retry is the step, so the words leave out sending again.
      const retryControl = held === null || entry.clientMessageId === held
      const text = deliveryNoticeText(entry, { agentName, retryControl })
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        retryControl ? { text, onRetry: () => retry(entry.clientMessageId) } : { text }
      )
    }
  }
  return notices
}
