// What the queued-message cards above the composer show, derived per publish —
// the wire carries no hold label (§ labels are client policy, not host state).

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'

/** Why a card is not on its way right now; decides the caption under the text. */
export type QueuedMessageCardHold =
  | 'turn'
  | 'awaiting-answer'
  | 'paused'
  | 'behind-returned'
  | 'returned'

export type QueuedMessageCard = {
  messageId: string
  position: number
  /** The draft's text blocks joined; drafts are text-only in v1. */
  text: string
  state: 'waiting' | 'returned'
  hold: QueuedMessageCardHold
  pausedReason?: string
  returnedReason?: string | null
}

export function queuedMessageCardText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/**
 * Cards in queue order. A waiting card whose submission already arrived is
 * suppressed locally: on a multi-page catch-up the shrunk list rides only the
 * final page, so the bubble and the card would otherwise briefly coexist.
 * Presentation only — no durable state. Returned cards never suppress: their
 * consumed submission exists precisely because it was refused.
 */
export function projectQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly AgentJournalSubmission[],
  session: { hasPendingPrompt: boolean }
): QueuedMessageCard[] {
  const consumed = new Set(submissions.map((submission) => submission.clientMessageId))
  const ordered = [...(queuedMessages ?? [])]
    .sort((left, right) => left.position - right.position)
    .filter((message) => message.state === 'returned' || !consumed.has(message.messageId))
  let behindReturned = false
  return ordered.map((message) => {
    const hold: QueuedMessageCardHold =
      message.state === 'returned'
        ? 'returned'
        : message.paused
          ? 'paused'
          : behindReturned
            ? 'behind-returned'
            : session.hasPendingPrompt
              ? 'awaiting-answer'
              : 'turn'
    behindReturned = behindReturned || message.state === 'returned'
    return {
      messageId: message.messageId,
      position: message.position,
      text: queuedMessageCardText(message.body),
      state: message.state,
      hold,
      ...(message.pausedReason !== undefined ? { pausedReason: message.pausedReason } : {}),
      ...(message.returnedReason !== undefined ? { returnedReason: message.returnedReason } : {})
    }
  })
}

/** The card Cmd/Ctrl+Enter steers: the newest one; every shown card takes Send-now. */
export function newestSteerableQueuedMessageCard(
  cards: readonly QueuedMessageCard[]
): QueuedMessageCard | null {
  return cards.at(-1) ?? null
}
