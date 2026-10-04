// Which of the structured chat's own messages say, on their row, that they did not go through, and
// which say quietly that they are still sending: every other one, until the host holds a row that
// has it (pending or accepted). A row in doubt or rejected does not, so it still reads as sending.
//
// Derived from the outbox on every render and never stored: each failed or held message carries
// its own typed failure, so each row words its own reason. Read through the drain's own rule: while
// the queue is stopped, the message it stopped on and any failed one ahead of it have a Retry, as
// each would go out at once; one behind it would wait unseen. One waiting behind has no failure of
// its own, so it reads as sending; a rejected or refused message holds nothing up, so it keeps its
// words and gets its Retry once the queue moves.
//
// A message the host recorded and then rejected is worded from the journal's own fact, found by id;
// the message keeps only a smaller copy, read when its submission is not loaded. A rejection a
// loaded host row already states (a failed start's, or a command's result row) says only that it
// was not sent: the row already says why. One no outbox entry here carries (another client's
// send, or one whose entry is gone) is worded from the journal alone, with no Retry: this client
// holds nothing to send.

import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import {
  structuredAgentSessionEntryIdExpired,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import {
  admitStructuredAgentSessionOutboxEntry,
  structuredAgentSessionEntryHeldForRetry
} from '../../../../shared/structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from '../../../../shared/structured-agent-session-draft-hand-off'
import { structuredAgentSessionEntryResendsUnconfirmed } from '../../../../shared/structured-agent-session-outbox-unconfirmed-resend'
import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session-failure-words'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import {
  agentSessionFailureStatedByStartRow,
  structuredAgentSessionRecordedRejectionParts
} from '../../../../shared/structured-agent-session-recorded-rejection-words'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }

/** Whether the entry's words say only that it was not sent, never that it may have landed. */
function deliveryNoticeSaysNotSent(entry: StructuredAgentSessionOutboxEntry): boolean {
  return (
    !deliveryIsInDoubt(entry) && !(entry.lastFailure && structuredAgentSessionEntryIdExpired(entry))
  )
}

function deliveryIsInDoubt(entry: StructuredAgentSessionOutboxEntry): boolean {
  // A send attempted before a Stop and then interrupted may already be with the host.
  const attemptedAcrossStop =
    entry.outlivedStop === true && entry.lastAttemptAt !== null && !entry.lastFailure
  return entry.state === 'unconfirmed' || attemptedAcrossStop
}

function deliveryNoticeText(
  entry: StructuredAgentSessionOutboxEntry,
  context: AgentSessionFailureWordsContext,
  recorded: AgentJournalSubmission | undefined,
  startFailures: readonly AgentSessionFailureFact[],
  failedHere: ReadonlySet<string>
): string {
  if (deliveryIsInDoubt(entry)) {
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
  // An earlier attempt under the id the host forgot may already be in the chat.
  if (structuredAgentSessionEntryIdExpired(entry)) {
    return agentSessionWriteNoticeText(['outcomeUnknown'])
  }
  // Its cause may have cleared since it was saved; a Retry it still stops brings the cause back.
  if (structuredAgentSessionEntryHeldForRetry(entry) && !failedHere.has(entry.clientMessageId)) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  if (
    entry.state === 'rejected' &&
    agentSessionFailureStatedByStartRow(recorded?.rejection, startFailures)
  ) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  return agentSessionWriteNoticeText(
    structuredAgentSessionAttemptFailureParts(
      entry.lastFailure,
      context,
      readWholeAgentSessionFailureFact(recorded?.rejection)
    )
  )
}

/** Keyed by the message id the transcript renders each entry under; `agentName` is the chat's
 *  agent, for the words. */
export function structuredAgentSessionDeliveryNotices(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  agentName: string,
  retry: (clientMessageId: string) => void,
  /** The journal's rows: rejected ones carry more of a rejection than the message keeps, and a
   *  message with no pending or accepted one is still sending. */
  submissions: readonly AgentJournalSubmission[],
  /** What the loaded start-failure rows state, from `structuredAgentSessionStartFailureFacts`. */
  startFailures: readonly AgentSessionFailureFact[],
  /** Ids whose send failed or was refused while this chat was open: only they word their cause. */
  failedHere: ReadonlySet<string>,
  /** Commands whose loaded result row says how they ended, from `structuredAgentSessionCommandResultRows`. */
  commandResults?: ReadonlySet<string>
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  // As the transcript reads it, so a row that lands is answered here before the outbox commits it.
  const entries = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions)
  const admission = admitStructuredAgentSessionOutboxEntry(entries)
  const held = admission.state === 'blocked' ? admission.entry.clientMessageId : null
  const stalledFrom = admission.state === 'blocked' ? entries.indexOf(admission.entry) : -1
  const rejected = new Map(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => [submission.clientMessageId, submission])
  )
  const notices = new Map<string, NativeChatDeliveryNotice>()
  for (const [index, entry] of entries.entries()) {
    // Resent under its own id until the journal answers, so still sending, not failed.
    if (
      !structuredAgentSessionEntryResendsUnconfirmed(entry, submissions) &&
      (entry.state === 'rejected' ||
        structuredAgentSessionEntryHeldForRetry(entry) ||
        entry.clientMessageId === held)
    ) {
      // Its own Retry is the step, so the words leave out sending again.
      const retryControl = stalledFrom === -1 || index <= stalledFrom
      const text = deliveryNoticeText(
        entry,
        { agentName, retryControl },
        rejected.get(entry.clientMessageId),
        startFailures,
        failedHere
      )
      notices.set(agentJournalSubmissionKey(entry.clientMessageId), {
        text,
        ...(deliveryNoticeSaysNotSent(entry) ? { notSent: true as const } : {}),
        ...(retryControl ? { onRetry: () => retry(entry.clientMessageId) } : {})
      })
    } else if (
      !submissions.some(
        (submission) =>
          submission.clientMessageId === entry.clientMessageId &&
          (submission.dispatchState === 'pending' || submission.dispatchState === 'accepted')
      )
    ) {
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        STRUCTURED_AGENT_SESSION_DELIVERY_SENDING
      )
    }
  }
  for (const submission of rejected.values()) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    if (!notices.has(id) && !dispatchWasWithdrawn(submission)) {
      notices.set(id, {
        notSent: true,
        text: agentSessionWriteNoticeText(
          structuredAgentSessionRecordedRejectionParts(
            submission,
            { agentName, retryControl: false },
            startFailures,
            commandResults
          )
        )
      })
    }
  }
  return notices
}
