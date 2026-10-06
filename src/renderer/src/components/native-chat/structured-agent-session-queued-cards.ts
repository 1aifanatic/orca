// What the queued-message cards above the composer show, derived per publish —
// the wire carries no hold label (§ labels are client policy, not host state).

import type { UnreadAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
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
  /** The whole queue is paused: the header row says why and offers Resume, so the card makes
   *  no promise about when it sends — not even after an answer, which does not drain it. */
  | 'queue-paused'
  | 'awaiting-answer'
  | 'paused'
  | 'behind-returned'
  | 'returned'
  /** On its way to the host, which holds no card for it yet: it reads as sending, and nothing
   *  can act on it until the host's card replaces it under the same id. */
  | 'sending'

export type QueuedMessageCard = {
  messageId: string
  position: number
  /** The draft's text blocks joined; drafts are text-only in v1. */
  text: string
  state: 'waiting' | 'returned'
  hold: QueuedMessageCardHold
  /** A conversation command such as /compact: it never steers into a running turn. */
  command?: true
  /** A command card while the agent works: it offers no send until the agent is idle. */
  waitsForAgent?: true
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
  session: { hasPendingPrompt: boolean; queuePaused?: boolean; agentWorking?: boolean }
): QueuedMessageCard[] {
  const handedOff = handedOffQueuedMessageIds(
    submissions.filter((submission) => submission.dispatchState !== 'rejected')
  )
  const ordered = [...(queuedMessages ?? [])]
    .sort((left, right) => left.position - right.position)
    .filter((message) => message.state === 'returned' || !handedOff.has(message.messageId))
  let behindReturned = false
  return ordered.map((message) => {
    const hold: QueuedMessageCardHold =
      message.state === 'returned'
        ? 'returned'
        : message.paused
          ? 'paused'
          : behindReturned
            ? 'behind-returned'
            : session.queuePaused
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
      ...(message.body.command !== undefined
        ? {
            command: true as const,
            ...(session.agentWorking ? { waitsForAgent: true as const } : {})
          }
        : {}),
      ...(message.pausedReason !== undefined ? { pausedReason: message.pausedReason } : {}),
      ...(message.returnedReason !== undefined ? { returnedReason: message.returnedReason } : {}),
      ...(message.returnedRejection !== undefined
        ? { returnedRejection: message.returnedRejection }
        : {})
    }
  })
}

/** The card Cmd/Ctrl+Enter steers: the newest one, unless it is a command, which never steers. */
export function newestSteerableQueuedMessageCard(
  cards: readonly QueuedMessageCard[]
): QueuedMessageCard | null {
  const newest = cards.at(-1)
  return newest && !newest.command && newest.hold !== 'sending' ? newest : null
}

/** A queue send still on its way, as the card it is about to become. */
export function sendingQueuedMessageCards(
  entries: readonly StructuredAgentSessionOutboxEntry[]
): QueuedMessageCard[] {
  return entries.map((entry, index) => ({
    messageId: entry.clientMessageId,
    // After every card the host holds, in send order.
    position: Number.MAX_SAFE_INTEGER - entries.length + index,
    text: queuedMessageCardText(entry.body),
    state: 'waiting',
    hold: 'sending'
  }))
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
  const onItsWay = new Set(outboxQueueSendsOnTheirWay(outbox, heldIds, isWorking, host))
  const next = outbox.filter((entry) => !held.has(entry.clientMessageId) && !onItsWay.has(entry))
  return next.length === outbox.length ? outbox : next
}

/** The queue sends on their way that the host holds no card for yet: shown as sending cards. */
export function outboxQueueSendsOnTheirWay(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  heldIds: readonly string[],
  isWorking: boolean,
  host: StructuredAgentSessionQueueDelivery
): StructuredAgentSessionOutboxEntry[] {
  if (!isWorking) {
    return []
  }
  const held = new Set(heldIds)
  const admission = admitStructuredAgentSessionOutboxEntry(outbox)
  const stalledFrom = admission.state === 'blocked' ? outbox.indexOf(admission.entry) : -1
  return outbox.filter(
    (entry, index) =>
      !held.has(entry.clientMessageId) &&
      (stalledFrom === -1 || index < stalledFrom) &&
      (entry.state === 'queued' || entry.state === 'dispatching') &&
      !structuredAgentSessionEntryHeldForRetry(entry) &&
      structuredAgentSessionEntryAsksToQueue(entry, host)
  )
}
