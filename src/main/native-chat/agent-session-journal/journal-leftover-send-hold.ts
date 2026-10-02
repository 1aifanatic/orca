// What becomes of a send an earlier host process accepted and never handed over: it was quit or
// crashed first, so the agent provably never got it. A person's message (typed, or a launch's first
// prompt) is kept as a waiting card at the head of the queue, held until someone acts on the queue
// (`QUEUED_MESSAGE_HELD_ACROSS_RESTART`). Everything else is rejected as before, because something
// else re-derives it or the person re-runs it. Either way the submission itself is rejected, so it
// is never handed over twice.

import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { AgentSessionJournal } from './journal-store'
import type { JournalRowTransactionHook } from './journal-row-writer'
import { QUEUED_MESSAGE_HELD_ACROSS_RESTART } from './queued-message-pause'
import type { QueuedMessagePositionMove } from './queued-message-positions'

/** The body a leftover send is kept with, or null when it is rejected instead:
 *  - a card's own hand-off: its rejection already sends the card back to waiting;
 *  - `/compact` and other commands: a command in flight is not resumed, the person re-runs it;
 *  - an image: cards are text-only;
 *  - orchestration mail (the mailbox re-sends it), a restart continuation (its offer is
 *    re-derived), and a row with no source that is not a person's (it could be either). */
export function leftoverSendHeldAsCard(
  submission: Pick<AgentJournalSubmission, 'queuedMessageId' | 'source' | 'origin'>,
  body: AgentJournalItemBody | null
): AgentJournalMessageItem | null {
  if (submission.queuedMessageId !== undefined || body?.kind !== 'message' || body.command) {
    return null
  }
  if (!body.blocks.every((block) => block.type === 'text')) {
    return null
  }
  const { source } = submission
  const persons =
    source === 'person' ||
    source === 'launch' ||
    // A build before `source` was recorded: `client` was only ever a person's send.
    (source === undefined && submission.origin === 'client')
  return persons ? body : null
}

type Placed = { sequence: number; move: QueuedMessagePositionMove }

/**
 * Settles every send an earlier host process left queued. Each is rejected as `hostRestarted` in
 * its own row, and a kept one becomes a card in that row's transaction, so a crash between them
 * can never leave both. The kept cards, a card hand-off's own card, and cards an interrupted
 * earlier run already kept go to the head of the queue in the order they were accepted, placed
 * once for the whole batch. Throws once every row was tried when one of them could not be written:
 * it stays queued for the next open or delivery step, and must not be handed over.
 */
export async function holdJournalLeftoverSends(
  journal: AgentSessionJournal,
  fence: number
): Promise<void> {
  if (journal.isReadOnly) {
    return
  }
  const leftovers = journal
    .submissions()
    .filter(
      (entry) =>
        isQueuedAgentJournalSubmission(entry) && journal.wroteBeforeOpen(entry.acceptedSequence)
    )
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
  if (leftovers.length === 0) {
    return
  }
  const { epoch } = journal.cursor()
  const kept = leftovers.map((submission) => ({
    submission,
    body: leftoverSendHeldAsCard(
      submission,
      journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
    )
  }))
  const positions = headOfQueuePositions(journal, kept)
  const rejection = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
    surface: 'rejection'
  })
  const failures: unknown[] = []
  for (const [index, { submission, body }] of kept.entries()) {
    const { clientMessageId } = submission
    const moves = [
      // Cards an interrupted earlier run kept move with the first row.
      ...(index === 0 ? positions.earlier : []),
      ...(submission.queuedMessageId !== undefined
        ? positions.placed.filter(
            (entry) => 'consumedAs' in entry && entry.consumedAs === clientMessageId
          )
        : [])
    ]
    const position = positions.placed.find(
      (entry) => 'messageId' in entry && entry.messageId === clientMessageId
    )?.position
    const hold: JournalRowTransactionHook | undefined =
      body || moves.length > 0
        ? (db) => {
            journal.queuedMessages.holdInTransaction(db, {
              card:
                body && position !== undefined
                  ? {
                      messageId: clientMessageId,
                      body,
                      fingerprint: structuredAgentSessionPayloadFingerprint({
                        method: 'agentSession.send',
                        sessionId: journal.queuedMessages.sessionId,
                        fields: { body }
                      }),
                      hostInstance: QUEUED_MESSAGE_HELD_ACROSS_RESTART,
                      queuedAt: { epoch, sequence: submission.acceptedSequence ?? 0 },
                      position
                    }
                  : null,
              positions: moves
            })
          }
        : undefined
    const reject = {
      clientMessageId,
      state: 'rejected' as const,
      ...rejection,
      fence,
      recovered: true as const
    }
    try {
      await journal.resolveDispatch(reject, hold)
    } catch (error) {
      if (!hold) {
        failures.push(error)
        continue
      }
      // Keeping it failed: rejected as before, which loses nothing an older build kept.
      console.warn('[journal-open] keeping a send a restart interrupted failed:', {
        sessionId: journal.queuedMessages.sessionId,
        clientMessageId,
        error: error instanceof Error ? error.message : String(error)
      })
      await journal.resolveDispatch(reject).catch((fallback: unknown) => failures.push(fallback))
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'settling sends an earlier host process left queued failed')
  }
}

/** Where each card of the batch goes: the cards it keeps, the hand-offs' own cards, and cards an
 *  interrupted earlier run kept, in acceptance order, right before every other card. */
function headOfQueuePositions(
  journal: AgentSessionJournal,
  kept: readonly { submission: AgentJournalSubmission; body: AgentJournalMessageItem | null }[]
): { placed: QueuedMessagePositionMove[]; earlier: QueuedMessagePositionMove[] } {
  const cards = journal.queuedMessages.list()
  const head: (Placed & { earlier?: true })[] = []
  for (const card of cards) {
    if (
      card.state === 'waiting' &&
      card.hostInstance === QUEUED_MESSAGE_HELD_ACROSS_RESTART &&
      card.carriedFrom === null
    ) {
      head.push({
        sequence: card.queuedAt?.sequence ?? 0,
        move: { messageId: card.messageId, position: 0 },
        earlier: true
      })
    }
  }
  for (const { submission, body } of kept) {
    const sequence = submission.acceptedSequence ?? 0
    const { clientMessageId } = submission
    if (body) {
      head.push({ sequence, move: { messageId: clientMessageId, position: 0 } })
    } else if (cards.some((card) => card.consumedAs === clientMessageId)) {
      head.push({ sequence, move: { consumedAs: clientMessageId, position: 0 } })
    }
  }
  const inHead = (card: (typeof cards)[number]): boolean =>
    head.some(({ move }) =>
      'messageId' in move ? move.messageId === card.messageId : move.consumedAs === card.consumedAs
    )
  const others = cards.filter((card) => !inHead(card)).map((card) => card.position)
  const anchor = others.length > 0 ? Math.min(...others) : 1
  head.sort((a, b) => a.sequence - b.sequence)
  const placed = head.map((entry, index) => ({
    ...entry,
    move: { ...entry.move, position: anchor - head.length + index }
  }))
  return {
    placed: placed.filter((entry) => !entry.earlier).map((entry) => entry.move),
    earlier: placed.filter((entry) => entry.earlier).map((entry) => entry.move)
  }
}
