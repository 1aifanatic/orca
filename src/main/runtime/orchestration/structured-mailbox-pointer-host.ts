/**
 * The structured-session half of the structured pointer lane.
 *
 * Keeps every `getStructuredAgentSessionHost()` call in one place so the delivery policy above it
 * stays pure and testable. Nothing here decides whether to deliver; it only performs the reads and
 * the send and reports what the host said.
 */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'
import type {
  StructuredChatMail,
  StructuredChatMailHost,
  StructuredMailCardState
} from './structured-chat-mail'
import type { OrchestrationMail } from '../../../shared/agent-session-message-source'
import type { QueuedMessageRow } from '../../native-chat/agent-session-journal/queued-message-table'
import {
  structuredAgentMailFacts,
  withdrawStructuredAgentCards
} from '../../native-chat/agent-session-wire/structured-agent-session-agent-mail'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import { sendAgentTurn } from './send-agent-turn'

/** Per-dispatch so one worker's nudges cannot exhaust the shared runtime operation-ledger budget. */
export function structuredPointerCallerKey(dispatchId: string): string {
  return `trusted-local:orchestration:${dispatchId}`
}

/**
 * The same budget for direct peer mail, which is addressed to the worker's own handle and has no
 * dispatch to scope to.
 *
 * A separate key rather than a reshaped one: the ledger is keyed on (callerKey, operationId), so
 * changing the dispatch key's shape would orphan every nudge already in flight under the old one.
 */
export function structuredSessionPointerCallerKey(sessionId: string): string {
  return `trusted-local:orchestration:session:${sessionId}`
}

/**
 * Whether a structured session is idle, for group addressing (`@idle`), read off its FULL reduced
 * timeline.
 *
 * Never a bounded page. A settled turn's lifecycle item is revised in place, so on any tail window
 * an idle session and a busy one whose lifecycle item scrolled off look identical — and
 * idle-with-history is the normal steady state of a working agent.
 */
export async function readStructuredSessionGateFacts(
  sessionId: string
): Promise<StructuredSessionGateFacts | null> {
  const snapshot = await readSession(sessionId, (host) => host.journalSnapshot(sessionId))
  return snapshot ? structuredSessionGateFacts(snapshot.items) : null
}

/** Withdrawals of a card by Orca carry this key; any other withdrawal of an agent's card is the
 *  person's. */
const ORCHESTRATION_CALLER_PREFIX = 'trusted-local:orchestration:'
const CARD_WITHDRAWAL_CALLER_KEY = `${ORCHESTRATION_CALLER_PREFIX}mail-card`

/** A chat's agent cards and agent sends; the journal and queue are read in one host call. */
export function readStructuredChatMail(sessionId: string): Promise<StructuredChatMail | null> {
  return readSession(sessionId, async (host) => {
    const { cards, sends } = structuredAgentMailFacts(await host.conversationJournal(sessionId))
    return {
      cards: cards.flatMap(({ messageId, source, ...row }) =>
        source.kind === 'agent' && source.orchestration.message === 'mail'
          ? [
              {
                cardId: messageId,
                mailbox: source.orchestration.mailbox,
                messageIds: mailIds(source.orchestration),
                state: cardState(row)
              }
            ]
          : []
      ),
      sends: sends.flatMap(({ submission, source }) =>
        source?.orchestration.message === 'mail'
          ? [
              {
                mailbox: source.orchestration.mailbox,
                messageIds: mailIds(source.orchestration),
                dispatchState: submission.dispatchState
              }
            ]
          : []
      ),
      submissions: sends.map(({ submission }) => submission)
    }
  })
}

function mailIds(mail: OrchestrationMail): string[] {
  return mail.messages.map((message) => message.messageId)
}

function cardState(row: Pick<QueuedMessageRow, 'state' | 'settledByOp'>): StructuredMailCardState {
  if (row.state !== 'withdrawn') {
    return row.state
  }
  return row.settledByOp?.startsWith(ORCHESTRATION_CALLER_PREFIX) ? 'withdrawn' : 'declined'
}

async function withdrawStructuredMailCards(
  sessionId: string,
  cardIds: readonly string[]
): Promise<readonly string[]> {
  return (
    (await readSession(sessionId, async (host) =>
      withdrawStructuredAgentCards(await host.conversationJournal(sessionId), {
        sessionId,
        cardIds,
        callerKey: CARD_WITHDRAWAL_CALLER_KEY
      })
    )) ?? []
  )
}

export const structuredChatMailHost: StructuredChatMailHost = {
  readChatMail: readStructuredChatMail,
  withdrawCards: withdrawStructuredMailCards
}

async function readSession<T>(
  sessionId: string,
  read: (host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>) => Promise<T>
): Promise<T | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    // Opens a conversation the idle sweep closed; that starts no agent.
    return await read(host)
  } catch (error) {
    // Not attached is a retain reason, not a failure; anything else is still unreadable.
    if ((error as Error)?.message !== AGENT_SESSION_NOT_ATTACHED.code) {
      console.warn('[orchestration] structured journal unreadable', sessionId, error)
    }
    return null
  }
}

export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  return {
    ...structuredChatMailHost,

    currentFence(sessionId) {
      return (
        getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null
      )
    },

    async send(input) {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      const outcome = await sendAgentTurn({
        kind: 'structured-session',
        host,
        sessionId: input.sessionId,
        callerKey: input.dispatchId
          ? structuredPointerCallerKey(input.dispatchId)
          : structuredSessionPointerCallerKey(input.sessionId),
        turn: {
          body: input.body,
          // As a person's message is: a busy chat queues it as a card, sent when the turn ends.
          delivery: 'queue',
          source: input.source,
          operationId: input.operationId,
          expectedRuntimeFence: input.expectedRuntimeFence
        }
      })
      switch (outcome.kind) {
        case 'refused':
          return outcome.refusal.code === AGENT_SESSION_NOT_ATTACHED.code
            ? { kind: 'unattached' }
            : { kind: 'refused' }
        case 'queued':
          return { kind: 'queued' }
        case 'sent': {
          // `pending` is not yet an acknowledgement; only `accepted` may consume mail. A send still
          // pending after the wait parks for the next journal edge.
          const state = outcome.submission?.dispatchState
          return {
            kind: 'sent',
            state: state === 'accepted' ? 'accepted' : state === 'rejected' ? 'rejected' : 'unknown'
          }
        }
      }
    }
  }
}
