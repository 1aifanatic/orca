// Render models for the host-held queued drafts shown above the composer.
// The wire carries no hold copy on purpose: the label is derived here from the
// draft's own state plus the live facts the client already holds.

import { readAgentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { agentSessionWriteNoticeEnglish } from '../../../src/shared/agent-session-refusal-notice'
import { dispatchWasWithdrawn } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionAttemptFailureParts } from '../../../src/shared/structured-agent-session-send-disposition'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  QUEUED_MESSAGE_PAUSED_STOPPED,
  type AgentSessionQueuedMessage
} from '../../../src/shared/agent-session-wire'

export type MobileQueuedMessageCard = {
  messageId: string
  /** The draft's text blocks joined for display and for Edit's composer copy. */
  text: string
  state: 'waiting' | 'returned'
  paused: boolean
  /** One-line status under the text. */
  label: string
}

function queuedMessageBodyText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function returnedLabel(
  draft: Pick<AgentSessionQueuedMessage, 'returnedReason' | 'returnedRejection'>
): string {
  const reason = draft.returnedReason ?? null
  const rejection = draft.returnedRejection
  if (dispatchWasWithdrawn({ dispatchState: 'rejected', reason, rejection })) {
    return 'Stopped before it was sent'
  }
  // Worded as the desktop card words it: the fact decides, the reason is the fallback, and the
  // card's own Send is the retry, so the words leave out sending again.
  return agentSessionWriteNoticeEnglish(
    structuredAgentSessionAttemptFailureParts(
      { kind: 'rejected', reason },
      { retryControl: true },
      readAgentSessionFailureFact(rejection)
    )
  )
}

function pausedLabel(reason: string | undefined): string {
  if (reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
    return "Couldn't send — tap Send to retry"
  }
  if (reason === QUEUED_MESSAGE_PAUSED_STOPPED) {
    // A Stop, /clear carry, or restart hold: the user's next sent message lifts it.
    return 'Paused — sends after your next message'
  }
  // Absent or unknown (newer host) marker: a plain pause, promising no release rule.
  return 'Paused'
}

/** Cards in published order. A waiting card whose submission already arrived is hidden, as the
 *  desktop hides it: on a multi-page catch-up the shrunk list rides only the final page, so the
 *  bubble and the card would otherwise briefly show together. Returned cards always show: their
 *  submission exists precisely because it was refused. A rejected submission hides nothing: beside
 *  a waiting draft it means a Stop requeued it, and the transcript does not show it either. */
export function mobileQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null,
  submissions: readonly Pick<AgentJournalSubmission, 'clientMessageId' | 'dispatchState'>[],
  facts: { pendingPrompt: boolean }
): MobileQueuedMessageCard[] {
  if (!queuedMessages || queuedMessages.length === 0) {
    return []
  }
  const consumed = new Set(
    submissions.flatMap((submission) =>
      submission.dispatchState === 'rejected' ? [] : [submission.clientMessageId]
    )
  )
  let behindReturned = false
  const cards: MobileQueuedMessageCard[] = []
  for (const draft of queuedMessages) {
    if (draft.state !== 'returned' && consumed.has(draft.messageId)) {
      continue
    }
    const paused = draft.paused === true
    const label =
      draft.state === 'returned'
        ? returnedLabel(draft)
        : paused
          ? pausedLabel(draft.pausedReason)
          : behindReturned
            ? 'Waiting — a message ahead needs attention'
            : facts.pendingPrompt
              ? 'Waiting for your answer'
              : 'Queued — sends when the current turn ends'
    cards.push({
      messageId: draft.messageId,
      text: queuedMessageBodyText(draft.body),
      state: draft.state,
      paused,
      label
    })
    if (draft.state === 'returned') {
      behindReturned = true
    }
  }
  return cards
}
