/**
 * The structured-session half of the structured pointer lane.
 *
 * Keeps every `getStructuredAgentSessionHost()` call in one place so the delivery policy above it
 * stays pure and testable. Nothing here decides whether to deliver; it only performs the reads and
 * the send and reports what the host said.
 */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type {
  StructuredMailboxPointerHost,
  StructuredMailCard,
  StructuredMailFacts
} from './structured-mailbox-pointer-delivery'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { QueuedMessageRow } from '../../native-chat/agent-session-journal/queued-message-table'
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

/** Cards first: a card read as handed off then always finds its hand-off, committed with it. */
function readMailFacts(sessionId: string): Promise<StructuredMailFacts | null> {
  return readSession(sessionId, async (host) => {
    const rows = await host.queuedMessageRows(sessionId)
    const { submissions } = await host.journalSnapshot(sessionId)
    return { submissions, mailCards: mailCards(rows, submissions) }
  })
}

/** Reads the journal only when the queue handed some mail off, so a plain chat's edge costs little. */
function readHandedOffMailCards(sessionId: string): Promise<readonly StructuredMailCard[] | null> {
  return readSession(sessionId, async (host) => {
    const rows = (await host.queuedMessageRows(sessionId)).filter(
      (row) => row.state === 'dispatched' && row.source.kind === 'agent'
    )
    return rows.length === 0
      ? []
      : mailCards(rows, (await host.journalSnapshot(sessionId)).submissions)
  })
}

/**
 * Mail the chat's own queue carries in an agent's card it has not deleted: on its way to the chat
 * as a turn, or taken, so its `check` leaves it out. A deleted card carries nothing.
 */
export async function readQueuedChatMail(sessionId: string): Promise<readonly string[]> {
  const rows = await readSession(sessionId, (host) => host.queuedMessageRows(sessionId))
  return (rows ?? []).flatMap(({ state, source }) =>
    state !== 'withdrawn' && source.kind === 'agent'
      ? source.orchestration.messages.map((message) => message.messageId)
      : []
  )
}

function mailCards(
  rows: readonly QueuedMessageRow[],
  submissions: readonly AgentJournalSubmission[]
): StructuredMailCard[] {
  return rows.flatMap(({ messageId, state, source }) =>
    source.kind === 'agent'
      ? [
          {
            mailbox: source.orchestration.mailbox,
            messageIds: source.orchestration.messages.map((message) => message.messageId),
            unsent: state === 'waiting' || state === 'returned',
            accepted:
              submissions.findLast((entry) => entry.queuedMessageId === messageId)
                ?.dispatchState === 'accepted'
          }
        ]
      : []
  )
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
    readFacts: readMailFacts,
    readHandedOffMailCards,

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
            : { kind: 'sent', state: 'rejected' }
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
