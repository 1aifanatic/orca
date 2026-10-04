// What the structured chat's user messages say about their delivery, derived on every render and
// never stored:
// - one in this client's outbox reads quietly as sending until the host holds a row for it
//   (pending or accepted): nothing in the outbox has failed, since a send that ends leaves it;
// - one the host recorded and then did not deliver says so, muted, on every client, worded from
//   the journal's own fact. A rejection a loaded host row already states (a failed start's, or a
//   command's result row) says only that it was not sent: the row already says why;
// - one whose outcome the host lost when the process sending it went away says it is not
//   confirmed, once nothing is running that could still deliver it.

import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { reconcileStructuredAgentSessionOutboxWithQueue } from '../../../../shared/structured-agent-session-draft-hand-off'
import { structuredAgentSessionRecordedRejectionParts } from '../../../../shared/structured-agent-session-recorded-rejection-words'
import { isRecoveredStructuredAgentSessionSubmission } from '../../../../shared/structured-agent-session-unanswered-dispatch'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }

function hostHoldsIt(submissions: readonly AgentJournalSubmission[], id: string): boolean {
  return submissions.some(
    (submission) =>
      submission.clientMessageId === id &&
      (submission.dispatchState === 'pending' || submission.dispatchState === 'accepted')
  )
}

/** Keyed by the message id the transcript renders each one under; `agentName` is the chat's
 *  agent, for the words. */
export function structuredAgentSessionDeliveryNotices(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  agentName: string,
  /** The journal's rows: rejected ones carry their whole fact, and a message with no pending or
   *  accepted one is still sending. */
  submissions: readonly AgentJournalSubmission[],
  /** What the loaded start-failure rows state, from `structuredAgentSessionStartFailureFacts`. */
  startFailures: readonly AgentSessionFailureFact[],
  /** Commands whose loaded result row says how they ended, from `structuredAgentSessionCommandResultRows`. */
  commandResults?: ReadonlySet<string>,
  /** Whether the agent is working or starting, so a lost outcome may still resolve. */
  agentActive = false
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const notices = new Map<string, NativeChatDeliveryNotice>()
  // As the transcript reads it, so a row that lands is answered here before the outbox commits it.
  for (const entry of reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions)) {
    if (!hostHoldsIt(submissions, entry.clientMessageId)) {
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        STRUCTURED_AGENT_SESSION_DELIVERY_SENDING
      )
    }
  }
  for (const submission of submissions) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    if (notices.has(id)) {
      continue
    }
    if (submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)) {
      notices.set(id, {
        muted: true,
        text: agentSessionWriteNoticeText(
          structuredAgentSessionRecordedRejectionParts(
            submission,
            { agentName, retryControl: false },
            startFailures,
            commandResults
          )
        )
      })
    } else if (!agentActive && isRecoveredStructuredAgentSessionSubmission(submission)) {
      notices.set(id, {
        muted: true,
        text: translate(
          'components.native-chat.messageNotConfirmed',
          "Not confirmed. Send it again if the agent didn't answer it."
        )
      })
    }
  }
  return notices
}
