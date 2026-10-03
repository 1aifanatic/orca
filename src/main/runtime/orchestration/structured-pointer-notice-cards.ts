/**
 * What a mailbox's notice cards in a chat's queue say about its pointer.
 *
 * A card is found by what it is (an agent's mail notice for this mailbox, in the session the mailbox
 * reaches now), never by the id or session the lane last sent under: /clear carries a card into the
 * next conversation, and a restart or reset leaves cards no row names. The queue sends a card under
 * a fresh id whose submission names it (`queuedMessageId`); what it pointed at is the mail the card
 * last stood for, which the drain restates as it sends.
 */

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'

/** A card in the session's queue, as the lane reads it. */
export type StructuredPointerCard = {
  messageId: string
  state: 'waiting' | 'dispatched' | 'returned' | 'withdrawn'
  /** An agent's mail notice: the mailbox it points at and the mail it stands for. */
  notice: { mailbox: string; messageIds: readonly string[] } | null
  /** Withdrawn by an operation someone asked for (a person's Delete or Edit), not by the host. */
  withdrawnByRequest: boolean
}

/** What the lane reads of a session: what its sends settled as, and what became of its cards. */
export type StructuredPointerFacts = {
  /** Every send the session recorded, oldest first. */
  submissions: readonly Pick<
    AgentJournalSubmission,
    'clientMessageId' | 'dispatchState' | 'submittedAt' | 'queuedMessageId'
  >[]
  cards: readonly StructuredPointerCard[]
}

export type MailboxNoticeCards = {
  /** Every notice card for the mailbox, whatever became of it. */
  ids: ReadonlySet<string>
  /** One still waits (or came back to the person): the queue, or the person, owes its send. */
  waiting: boolean
  /** A hand-off not settled yet: in flight, or of unknown fate with no turn run since. */
  unsettled: 'send-unsettled' | 'dispatch-unknown' | null
  /** Mail a notice already pointed at: handed off and accepted, or declined by the person. */
  pointed: ReadonlySet<string>
}

export function readMailboxNoticeCards(
  mailboxHandle: string,
  facts: StructuredPointerFacts,
  owed: readonly string[]
): MailboxNoticeCards {
  const ids = new Set<string>()
  const pointed = new Set<string>()
  let waiting = false
  let unsettled: MailboxNoticeCards['unsettled'] = null
  for (const card of facts.cards) {
    if (card.notice?.mailbox !== mailboxHandle) {
      continue
    }
    ids.add(card.messageId)
    const pointedAt = card.notice.messageIds
    if (card.state === 'waiting' || card.state === 'returned') {
      waiting = true
    } else if (card.state === 'withdrawn') {
      // The host's own withdrawal (it owed nothing, or moved it) declines nothing.
      if (card.withdrawnByRequest) {
        pointedAt.forEach((id) => pointed.add(id))
      }
    } else {
      const handOff = facts.submissions.findLast(
        (entry) => entry.queuedMessageId === card.messageId
      )
      if (handOff?.dispatchState === 'accepted') {
        pointedAt.forEach((id) => pointed.add(id))
      } else if (handOff?.dispatchState === 'pending' || handOff?.dispatchState === 'rejected') {
        // A refusal is settled back onto the card by the host; that write is the next edge.
        unsettled = 'send-unsettled'
      } else if (
        handOff?.dispatchState === 'unknown' &&
        pointedAt.some((id) => owed.includes(id)) &&
        !facts.submissions.some(
          (entry) => entry.dispatchState === 'accepted' && entry.submittedAt > handOff.submittedAt
        )
      ) {
        // It may sit in the provider's input already; only a turn run since says it did not land.
        unsettled ??= 'dispatch-unknown'
      }
    }
  }
  return { ids, waiting, unsettled, pointed }
}
