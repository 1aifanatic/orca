// /clear's carry of the source's drafts to its replacement, and the re-derivation that finishes a
// carry a failure or a crash cut short.

import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import { QUEUED_MESSAGE_PAUSED_KEPT } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import { queuedMessageFingerprint } from './structured-agent-session-queued-messages'
import { unsettledQueuedMessages } from './structured-agent-session-queued-stop'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

export const STRUCTURED_AGENT_SESSION_CLEAR_COMMAND = 'clear'

/** What the queue's drain needs to run a /clear card itself. */
export type QueuedClearDrainDeps = {
  /** The card's turn, inside the drain's step; true once the clear committed. A card waiting on
   *  background tasks or a handoff stays waiting; their ending wakes the drain. */
  run: (sessionId: string, card: QueuedMessageRow) => Promise<boolean>
  /** Finishes the carry a committed clear owes its replacement, inside the step. */
  carry: (sessionId: string) => Promise<void>
  /** What follows a committed clear, outside the step: it closes the source, which serializes. */
  after: (sessionId: string) => Promise<void>
}

/** A /clear the queue holds: run by the host when its turn comes, never handed to the agent. */
export function isQueuedClearCard(row: Pick<QueuedMessageRow, 'body'>): boolean {
  return row.body.command?.name === STRUCTURED_AGENT_SESSION_CLEAR_COMMAND
}

/** The committed /clear that superseded this conversation; null while it is current. */
export function committedClearOf(
  record: AgentSessionRecord | null
):
  | (NonNullable<AgentSessionRecord['conversationCommand']> & { replacementSessionId: string })
  | null {
  const command = record?.conversationCommand
  return command?.command === 'clear' &&
    command.phase === 'committed' &&
    command.replacementSessionId
    ? { ...command, replacementSessionId: command.replacementSessionId }
    : null
}

/** The clear committed with drafts still on its source: the carry it owes, re-derived. */
export function clearCarryOwed(
  record: AgentSessionRecord | null,
  journal: Pick<AgentSessionJournal, 'queuedMessages'>
): boolean {
  return (
    committedClearOf(record) !== null &&
    journal.queuedMessages.list().some(isUnsettledQueuedMessage)
  )
}

/**
 * The source's unsettled drafts become rows on the replacement — the SAME for every client
 * version, with no text on the wire — so the cards stay visible where the user now is. Which rule
 * a card follows is derived from the /clear card the clear ran from, if any (its id is the clear's
 * `operationId`):
 *   - sent after that card: carried in order and unpaused, commands too. They were written for
 *     the fresh chat, so they run there as they would have here.
 *   - sent before the clear (an immediate /clear over a paused queue): a message card carries
 *     over paused ('cleared', lifted like a Stop's), since it was written for the context the
 *     clear discarded; a command card, kept or not, is withdrawn without a copy.
 * A kept send (`QUEUED_MESSAGE_PAUSED_KEPT`) keeps that hold wherever it lands.
 * Runs after the clear commits, opening the replacement only when there is something to carry;
 * the source rows, the /clear card included, are tombstoned last, so a cut-short carry still
 * finds the card that orders it. Bookkeeping around the clear: a failure is reported, never gates
 * the clear, and is finished by `clearCarryOwed` when either conversation next opens. A crash
 * between the copy and the tombstone leaves both, which the supersession fence makes harmless:
 * the copy is keyed by the card's id, so the next carry finds it and adds nothing.
 */
export async function carryQueuedMessagesToClearReplacement(
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'journal' | 'logger'>,
  input: {
    replacementSessionId: string
    openReplacementJournal: () => Promise<AgentSessionJournal | undefined>
    callerKey: string
    operationId: string
  }
): Promise<void> {
  try {
    const rows = unsettledQueuedMessages(ctx.journal)
    if (rows.length === 0) {
      return
    }
    const clearCard = ctx.journal.queuedMessages.get(input.operationId)
    const behind = clearCard && isQueuedClearCard(clearCard) ? clearCard.position : Infinity
    const carried = rows.filter(
      (row) => row.messageId !== input.operationId && (row.position > behind || !row.body.command)
    )
    if (carried.length > 0) {
      const replacement = await input.openReplacementJournal()
      if (!replacement) {
        throw new Error('the replacement journal is not open')
      }
      for (const row of carried) {
        // A returned card carries over as a plain waiting draft — its refusal
        // belonged to the source's submissions. The fingerprint is re-scoped to the
        // replacement, or its echo could never alias the sent bubble.
        await replacement.queuedMessages.insert({
          messageId: row.messageId,
          body: row.body,
          fingerprint: queuedMessageFingerprint(input.replacementSessionId, row.body),
          // Its own: a card a process that has since died wrote keeps that restart's pause.
          hostInstance: row.hostInstance,
          ...(row.position > behind ? {} : { carriedFrom: ctx.sessionId }),
          source: row.source,
          // A kept send stays held there too, before or behind the clear: only its person's Send
          // sends it, never the queue.
          ...(row.holdReason === QUEUED_MESSAGE_PAUSED_KEPT
            ? { holdReason: QUEUED_MESSAGE_PAUSED_KEPT }
            : {})
        })
      }
    }
    await ctx.journal.queuedMessages.withdraw({
      messageIds: rows.map((row) => row.messageId),
      settledByOp: agentSessionOperationKey(input.callerKey, input.operationId)
    })
  } catch (error) {
    ctx.logger.warn("carrying queued drafts to /clear's replacement failed", {
      scope: 'clear-queued-carry',
      sessionId: ctx.sessionId,
      replacementSessionId: input.replacementSessionId,
      error
    })
  }
}
