// Which of the structured chat's own messages say, on their row, that they did not go through.
//
// Derived from the outbox on every render and never stored: each failed or held message carries
// its own typed failure, so each row words its own reason and offers its own Retry. Read through
// the drain's own rule, so of the messages still to be sent only the one the queue stopped on has a
// Retry; one waiting behind it says nothing. A rejected message holds nothing and keeps its own.

import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import {
  admitStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

function deliveryNoticeText(entry: StructuredAgentSessionOutboxEntry): string {
  if (entry.state === 'unconfirmed') {
    return translate(
      'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
      'Message delivery is unconfirmed.'
    )
  }
  return entry.lastFailure
    ? agentSessionWriteNoticeText(structuredAgentSessionAttemptFailureParts(entry.lastFailure))
    : translate(
        'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
        'Message was not sent.'
      )
}

/** Keyed by the message id the transcript renders each entry under. `blockedClientMessageId` is
 *  the entry a refusal stopped the queue on. */
export function structuredAgentSessionDeliveryNotices(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  blockedClientMessageId: string | null,
  retry: (clientMessageId: string) => void
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const admission = admitStructuredAgentSessionOutboxEntry(outbox, blockedClientMessageId)
  const held = admission.state === 'blocked' ? admission.entry.clientMessageId : null
  const notices = new Map<string, NativeChatDeliveryNotice>()
  for (const entry of outbox) {
    if (entry.state === 'rejected' || entry.clientMessageId === held) {
      notices.set(agentJournalSubmissionKey(entry.clientMessageId), {
        text: deliveryNoticeText(entry),
        onRetry: () => retry(entry.clientMessageId)
      })
    }
  }
  return notices
}
