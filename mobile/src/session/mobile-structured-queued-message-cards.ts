// Render models for the host-held queued drafts shown above the composer.
// The wire carries no hold copy on purpose: the label is derived here from the
// draft's own state plus the live facts the client already holds.

import { dispatchRejectionReasonIsInternal } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import type {
  AgentSessionQueuedMessage,
  AgentSessionWithdrawnQueuedMessage
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
  // Same showability rule as rejected submissions: only a provider's own words
  // are worth reading verbatim.
  return reason && !dispatchRejectionReasonIsInternal(reason)
    ? reason
    : "Couldn't send — Send to retry"
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
          ? (draft.pausedReason ?? 'Paused')
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
