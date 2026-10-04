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
  /** Withdrawn by an operation someone asked for (a Delete of a card the person sees), not by the
   *  host. A hidden notice has no such operation until it is shown. */
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
  /** One still waits: the queue owes its send. */
  waiting: boolean
  /** A hand-off not settled yet: in flight; or refused, or of unknown fate, with no turn run since. */
  unsettled: 'send-unsettled' | 'dispatch-unknown' | 'dispatch-rejected' | null
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
    const handOff = facts.submissions.findLast((entry) => entry.queuedMessageId === card.messageId)
    // A send that failed, was stopped or is in doubt goes again only once a later turn shows the
    // agent can run, or newer mail makes it a different notice.
    const awaitsTurn =
      pointedAt.some((id) => owed.includes(id)) &&
      owed.every((id) => pointedAt.includes(id)) &&
      !facts.submissions.some(
        (entry) =>
          entry.dispatchState === 'accepted' &&
          handOff !== undefined &&
          entry.submittedAt > handOff.submittedAt
      )
    if (card.state === 'waiting' || card.state === 'returned') {
      waiting = true
    } else if (card.state === 'withdrawn') {
      if (card.withdrawnByRequest) {
        pointedAt.forEach((id) => pointed.add(id))
      } else if (handOff?.dispatchState === 'rejected' && awaitsTurn) {
        // The host withdrew a card the provider refused or a Stop pulled back.
        unsettled ??= 'dispatch-rejected'
      }
      // Any other host withdrawal (it owed nothing, or was moved) declines nothing.
    } else if (handOff?.dispatchState === 'accepted') {
      pointedAt.forEach((id) => pointed.add(id))
    } else if (handOff?.dispatchState === 'pending' || handOff?.dispatchState === 'rejected') {
      // A refusal is settled back onto the card by the host; that write is the next edge.
      unsettled = 'send-unsettled'
    } else if (handOff?.dispatchState === 'unknown' && awaitsTurn) {
      // It may sit in the provider's input already.
      unsettled ??= 'dispatch-unknown'
    }
  }
  return { ids, waiting, unsettled, pointed }
}
