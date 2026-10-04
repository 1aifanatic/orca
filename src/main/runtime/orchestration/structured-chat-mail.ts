/**
 * What a structured chat holds of its orchestration mail, derived each time from its queued cards
 * and its sends. The mailbox is the only record of what was read: a card only carries mail, a send
 * the chat accepted marks it read, and mail no card or unsettled send carries is free to push or
 * for `check` to return. The lane and the chat's own `check` change it one at a time.
 */

import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'
import type { AgentJournalDispatchState } from '../../../shared/agent-session-journal-types'
import type { OrchestrationDb } from './db'
import type { StructuredPointerSubmission } from './structured-pointer-operation-id'

/** `declined`: the person withdrew it, so its mail waits for `check`; `withdrawn`: Orca did. */
export type StructuredMailCardState =
  | 'waiting'
  | 'returned'
  | 'dispatched'
  | 'withdrawn'
  | 'declined'

/** An agent's card in the chat's queue. */
export type StructuredMailCard = {
  cardId: string
  mailbox: string
  messageIds: readonly string[]
  state: StructuredMailCardState
}

/** A turn the chat was sent carrying an agent's mail: directly, or as a card's hand-off. */
export type StructuredMailSend = {
  mailbox: string
  messageIds: readonly string[]
  dispatchState: AgentJournalDispatchState
}

export type StructuredChatMail = {
  cards: readonly StructuredMailCard[]
  sends: readonly StructuredMailSend[]
  /** Every send the session recorded, oldest first: what the lane's own direct sends settled as. */
  submissions: readonly StructuredPointerSubmission[]
}

export type StructuredChatMailHost = {
  /** `null` when the session cannot be read. */
  readChatMail: (sessionId: string) => Promise<StructuredChatMail | null>
  /** Withdraws these cards as Orca where still waiting or returned; answers which it withdrew. */
  withdrawCards: (sessionId: string, cardIds: readonly string[]) => Promise<readonly string[]>
}

const chatMailLocks = new Map<string, Promise<void>>()

export function withChatMailLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  return runKeyedSerializedOperation(chatMailLocks, sessionId, task)
}

/** A send the chat accepted carried these, wherever their mailbox routes now. */
export function markAcceptedChatMailRead(db: OrchestrationDb, mail: StructuredChatMail): void {
  const unread = mail.sends
    .filter((send) => send.dispatchState === 'accepted')
    .flatMap((send) => send.messageIds)
    .filter((id) => db.getMessageById(id)?.read === 0)
  if (unread.length > 0) {
    db.markAsReadAndDelivered(unread)
  }
}

/** Mail on its way to the chat: a send not settled yet. */
export function pendingChatMail(mail: StructuredChatMail): string[] {
  return mail.sends
    .filter((send) => send.dispatchState === 'pending')
    .flatMap((send) => send.messageIds)
}

/** The cards still in the queue, whose mail a push or `check` must leave to them. */
export function queuedMailCards(
  cards: readonly StructuredMailCard[]
): readonly StructuredMailCard[] {
  return cards.filter((card) => card.state === 'waiting' || card.state === 'returned')
}

/**
 * The lane's pass over a chat, before it chooses what to send: a declined card's mail is kept from
 * pushing (`delivered_at`), and Orca withdraws a returned card, a waiting one some of whose mail
 * was read, and one whose mailbox moved away. Answers the cards still carrying mail.
 */
export async function reconcileChatMail(input: {
  db: OrchestrationDb
  sessionId: string
  mail: StructuredChatMail
  host: StructuredChatMailHost
  ownsMailbox: (mailbox: string) => boolean
}): Promise<readonly StructuredMailCard[]> {
  const { db, mail } = input
  markAcceptedChatMailRead(db, mail)
  const unread = (id: string): boolean => db.getMessageById(id)?.read === 0
  const declined = mail.cards
    .filter((card) => card.state === 'declined')
    .flatMap((card) => card.messageIds)
    .filter(unread)
  if (declined.length > 0) {
    db.markAsDelivered(declined)
  }
  const queued = queuedMailCards(mail.cards)
  const stale = queued.filter(
    (card) =>
      card.state === 'returned' ||
      !input.ownsMailbox(card.mailbox) ||
      !card.messageIds.every(unread)
  )
  const withdrawn = new Set(
    stale.length > 0
      ? await input.host.withdrawCards(
          input.sessionId,
          stale.map((card) => card.cardId)
        )
      : []
  )
  return queued.filter((card) => !withdrawn.has(card.cardId))
}

/**
 * A chat's own consuming `check`: takes the mail of the cards in its queue that `candidates`
 * would read, withdrawing those cards, and answers what the read must still leave out. A card the
 * queue handed off first stays out; its send carries it.
 */
export async function takeChatMail(input: {
  db: OrchestrationDb
  sessionId: string
  mail: StructuredChatMail
  host: StructuredChatMailHost
  candidates: (exclude: readonly string[]) => readonly string[]
}): Promise<string[]> {
  const { mail } = input
  markAcceptedChatMailRead(input.db, mail)
  const pending = pendingChatMail(mail)
  const wanted = new Set(input.candidates(pending))
  const queued = queuedMailCards(mail.cards)
  const taking = queued.filter((card) => card.messageIds.some((id) => wanted.has(id)))
  const taken = new Set(
    taking.length > 0
      ? await input.host.withdrawCards(
          input.sessionId,
          taking.map((card) => card.cardId)
        )
      : []
  )
  return [
    ...pending,
    ...queued.filter((card) => !taken.has(card.cardId)).flatMap((card) => card.messageIds)
  ]
}
