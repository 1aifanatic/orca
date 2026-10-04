// Which of the structured chat's own messages say, on their row, that they did not go through, and
// which say quietly that they are still sending: every other one, until the host holds a row for it.
//
// Derived from the outbox on every render and never stored: each failed or held message carries
// its own typed failure, so each row words its own reason. Read through the drain's own rule: while
// the queue is stopped, the message it stopped on and any failed one ahead of it have a Retry, as
// each would go out at once; one behind it would wait unseen. One waiting behind has no failure of
// its own, so it reads as sending; a rejected or refused message holds nothing up, so it keeps its
// words and gets its Retry once the queue moves.
//
// A message the host recorded and then rejected is worded from the journal's own fact, found by id;
// the message keeps only a smaller copy, read when its submission is not loaded. A rejection that
// is a failed start's, the fact its loaded row states, says only that it was not sent: the row
// already says why.

import {
  readAgentSessionFailureFact,
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  structuredAgentSessionEntryIdExpired,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  admitStructuredAgentSessionOutboxEntry,
  structuredAgentSessionEntryHeldForRetry
} from '../../../../shared/structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from '../../../../shared/structured-agent-session-draft-hand-off'
import { structuredAgentSessionEntryResendsUnconfirmed } from '../../../../shared/structured-agent-session-outbox-unconfirmed-resend'
import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session-failure-words'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }

/** The facts the chat's loaded start-failure rows state. */
export function structuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[]
): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = []
  for (const item of items) {
    if (item.body.kind === 'status' && isStructuredAgentSessionStartFailureRow(item.itemId)) {
      const fact = readAgentSessionFailureFact(item.body.failure)
      if (fact) {
        facts.push(fact)
      }
    }
  }
  return facts
}

/** Whether two facts are one failure: a start's row and the messages it rejected share one. */
export function sameAgentSessionFailureFact(
  a: AgentSessionFailureFact,
  b: AgentSessionFailureFact
): boolean {
  return (
    a.kind === b.kind &&
    a.detail?.text === b.detail?.text &&
    a.detail?.audience === b.detail?.audience &&
    a.refusal?.code === b.refusal?.code &&
    a.refusal?.details?.reason === b.refusal?.details?.reason &&
    a.attachment?.reason === b.attachment?.reason &&
    a.attachment?.limit === b.attachment?.limit &&
    a.retry?.error === b.retry?.error &&
    a.retry?.status === b.retry?.status
  )
}

/** Whether a loaded start-failure row already states this failure. Matching is identity, not
 *  wording: what this build can read is enough. */
export function agentSessionFailureStatedByStartRow(
  failure: unknown,
  startFailures: readonly AgentSessionFailureFact[]
): boolean {
  const fact = readAgentSessionFailureFact(failure)
  return (
    fact !== undefined && startFailures.some((stated) => sameAgentSessionFailureFact(stated, fact))
  )
}

function deliveryNoticeText(
  entry: StructuredAgentSessionOutboxEntry,
  context: AgentSessionFailureWordsContext,
  recorded: AgentJournalSubmission | undefined,
  startFailures: readonly AgentSessionFailureFact[],
  failedHere: ReadonlySet<string>
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
   *  message with none yet is still sending. */
  submissions: readonly AgentJournalSubmission[],
  /** What the loaded start-failure rows state, from `structuredAgentSessionStartFailureFacts`. */
  startFailures: readonly AgentSessionFailureFact[],
  /** Ids whose send failed or was refused while this chat was open: only they word their cause. */
  failedHere: ReadonlySet<string>
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
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        retryControl ? { text, onRetry: () => retry(entry.clientMessageId) } : { text }
      )
    } else if (
      !submissions.some((submission) => submission.clientMessageId === entry.clientMessageId)
    ) {
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        STRUCTURED_AGENT_SESSION_DELIVERY_SENDING
      )
    }
  }
  return notices
}
