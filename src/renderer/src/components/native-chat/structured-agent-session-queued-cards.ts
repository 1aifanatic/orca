// What the queued-message cards above the composer show, derived per publish —
// the wire carries no hold label (§ labels are client policy, not host state).

import type { UnreadAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../shared/agent-session-wire'
import { handedOffQueuedMessageIds } from '../../../../shared/structured-agent-session-draft-hand-off'
import {
  structuredAgentSessionEntryAsksToQueue,
  type StructuredAgentSessionQueueDelivery
} from '../../../../shared/structured-agent-session-outbox-delivery'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  admitStructuredAgentSessionOutboxEntry,
  structuredAgentSessionEntryHeldForRetry
} from '../../../../shared/structured-agent-session-outbox-admission'

/** Why a card is not on its way right now; decides the caption under the text. */
export type QueuedMessageCardHold =
  | 'turn'
  /** Held by a Stop, restart or /clear: the header row above the cards says why and offers
   *  Resume, so the card makes no promise of when it sends — not even after an answer. */
  | 'queue-paused'
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
  /** The pause holding a 'queue-paused' card. A string: a newer host may name a reason this build
   *  does not know. */
  queuePause?: { reason: string }
  pausedReason?: string
  returnedReason?: string | null
  /** The typed fact the returned card's submission settled with; read like its `rejection`. */
  returnedRejection?: UnreadAgentSessionFailureFact
}

function queuedMessageCardText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/**
 * Cards in queue order. A waiting card is hidden once a submission hands it off
 * (`queuedMessageId`) and that hand-off is live: on a multi-page catch-up the shrunk
 * list rides only the final page, so the bubble and the card would otherwise briefly
 * coexist. A rejected hand-off is exactly what sent the draft back, so it hides
 * nothing. Presentation only — no durable state. Returned cards never hide.
 */
export function projectQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly AgentJournalSubmission[],
  session: { hasPendingPrompt: boolean; queuePause?: AgentSessionQueuePause | null }
): QueuedMessageCard[] {
  const handedOff = handedOffQueuedMessageIds(
    submissions.filter((submission) => submission.dispatchState !== 'rejected')
  )
  const ordered = [...(queuedMessages ?? [])]
    .sort((left, right) => left.position - right.position)
    .filter((message) => message.state === 'returned' || !handedOff.has(message.messageId))
  let behindReturned = false
  return ordered.map((message) => {
    // A host that predates `heldBy` publishes only the queue's pause, which then covers every card.
    const heldBy = message.heldBy === undefined ? (session.queuePause ?? null) : message.heldBy
    const hold: QueuedMessageCardHold =
      message.state === 'returned'
        ? 'returned'
        : message.paused
          ? 'paused'
          : behindReturned
            ? 'behind-returned'
            : heldBy
              ? 'queue-paused'
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
      ...(hold === 'queue-paused' && heldBy ? { queuePause: { reason: heldBy.reason } } : {}),
      ...(message.pausedReason !== undefined ? { pausedReason: message.pausedReason } : {}),
      ...(message.returnedReason !== undefined ? { returnedReason: message.returnedReason } : {}),
      ...(message.returnedRejection !== undefined
        ? { returnedRejection: message.returnedRejection }
        : {})
    }
  })
}

/** The pause the header row names, from the oldest card it holds. A pause over cards Resume would
 *  not send (returned, held on their own, or behind a returned one) offers nothing to press. */
export function queuedMessagesQueuePause(
  cards: readonly QueuedMessageCard[]
): { reason: string } | null {
  return cards.find((card) => card.hold === 'queue-paused')?.queuePause ?? null
}

/** The person's own message from this composer has reached the host as a direct send and waits
 *  for the agent to accept it. Its turn will lift the queue's pause, so the header row does not
 *  say paused meanwhile; a refusal settles the entry and the row comes back. An Orca send never
 *  enters this outbox, and the queue's send of a card goes under a fresh id. */
export function ownDirectSendOnItsWay(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): boolean {
  const pending = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'pending')
      .map((submission) => submission.clientMessageId)
  )
  return outbox.some((entry) => entry.state !== 'rejected' && pending.has(entry.clientMessageId))
}

/** Whether the composer's Resume would release anything: nothing runs, and a pause holds a card.
 *  `isWorking` counts the queue's coming send, which the host names. */
export function queuedMessagesResumable(
  cards: readonly QueuedMessageCard[],
  isWorking: boolean
): boolean {
  return !isWorking && queuedMessagesQueuePause(cards) !== null
}

/** Steer names the mid-turn jump, also while the whole queue is paused; a card held on its own or
 *  returned is not waiting on the turn, so its action is plainly Send. */
export function queuedMessageCardSteers(card: QueuedMessageCard): boolean {
  return card.hold !== 'paused' && card.hold !== 'returned'
}

/** The card Cmd/Ctrl+Enter steers: the newest one; every shown card takes Send-now. */
export function newestSteerableQueuedMessageCard(
  cards: readonly QueuedMessageCard[]
): QueuedMessageCard | null {
  return cards.at(-1) ?? null
}

/**
 * The outbox entries the transcript may show as pending bubbles. A send the host holds
 * as a draft (same id) is a card, and so is a send on its way out asking to be queued —
 * read from what its request carries — otherwise it paints
 * in the transcript until the queued answer retires it. A plain send stays a bubble. From
 * the entry the drain is stopped on (read through the drain's own rule), nothing is on its
 * way, nor is one held for its Retry: those stay bubbles so their text is visible beside the
 * Retry row.
 */
export function outboxOutsideQueuedCards(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  heldIds: readonly string[],
  isWorking: boolean,
  host: StructuredAgentSessionQueueDelivery
): readonly StructuredAgentSessionOutboxEntry[] {
  const held = new Set(heldIds)
  const admission = admitStructuredAgentSessionOutboxEntry(outbox)
  const stalledFrom = admission.state === 'blocked' ? outbox.indexOf(admission.entry) : -1
  const next = outbox.filter((entry, index) => {
    const onItsWay =
      isWorking &&
      (stalledFrom === -1 || index < stalledFrom) &&
      (entry.state === 'queued' || entry.state === 'dispatching') &&
      !structuredAgentSessionEntryHeldForRetry(entry) &&
      structuredAgentSessionEntryAsksToQueue(entry, host)
    return !held.has(entry.clientMessageId) && !onItsWay
  })
  return next.length === outbox.length ? outbox : next
}
