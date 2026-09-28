// Render models for the host-held queued drafts shown above the composer.
// The wire carries no hold copy on purpose: the label is derived here from the
// draft's own state plus the live facts the client already holds.

import {
  dispatchRejectionReasonIsInternal,
  dispatchWasWithdrawn
} from '../../../src/shared/structured-agent-session-dispatch-rejection'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionWithdrawnQueuedMessage
} from '../../../src/shared/agent-session-wire'

export type MobileQueuedMessageCard = {
  messageId: string
  /** The draft's text blocks joined for display and for Edit's composer restore. */
  text: string
  state: 'waiting' | 'returned'
  paused: boolean
  /** One-line status under the text. */
  label: string
}

export function queuedMessageBodyText(body: AgentSessionWithdrawnQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function returnedLabel(reason: string | null | undefined): string {
  if (dispatchWasWithdrawn({ dispatchState: 'rejected', reason: reason ?? null })) {
    return 'Held back by Stop — Send to retry'
  }
  // Same showability rule as rejected submissions: only a provider's own words
  // are worth reading verbatim; our internal markers map to English here
  // (mobile ships English only).
  return reason && !dispatchRejectionReasonIsInternal(reason)
    ? reason
    : "Couldn't send — Send to retry"
}

function pausedLabel(reason: string | undefined): string {
  if (reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
    return "Couldn't send — Send to retry"
  }
  // The wire carries markers, never copy; an unknown marker from a newer host
  // reads as a plain pause rather than leaking on screen.
  return 'Paused'
}

export function mobileQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null,
  facts: { pendingPrompt: boolean }
): MobileQueuedMessageCard[] {
  if (!queuedMessages || queuedMessages.length === 0) {
    return []
  }
  let behindReturned = false
  const cards: MobileQueuedMessageCard[] = []
  for (const draft of queuedMessages) {
    const paused = draft.paused === true
    const label =
      draft.state === 'returned'
        ? returnedLabel(draft.returnedReason)
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
