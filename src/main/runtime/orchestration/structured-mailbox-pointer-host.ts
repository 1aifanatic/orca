/**
 * The structured-session half of the structured pointer lane.
 *
 * Keeps every `getStructuredAgentSessionHost()` call in one place so the delivery policy above it
 * stays pure and testable. Nothing here decides whether to deliver; it only performs the read and
 * the send, and reports what the host said.
 */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import type { StructuredPointerFacts } from './structured-pointer-notice-cards'
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
 * The idle gate for a structured session, read off its FULL reduced timeline.
 *
 * Never a bounded page. A settled turn's lifecycle item is revised in place, so on any tail window
 * an idle session and a busy one whose lifecycle item scrolled off look identical — and
 * idle-with-history is the normal steady state of a working agent. Shared so the pointer lane and
 * group addressing cannot disagree about it.
 */
export async function readStructuredSessionGateFacts(
  sessionId: string
): Promise<StructuredSessionGateFacts | null> {
  const snapshot = await readSessionJournal(sessionId)
  return snapshot ? structuredSessionGateFacts(snapshot.items) : null
}

async function readSessionJournal(sessionId: string): Promise<AgentJournalSnapshot | null> {
  return readSession(sessionId, (host) => host.journalSnapshot(sessionId))
}

/** What each recorded send settled as, and every draft card, so the lane can find its own. Cards
 *  first: a card read as handed off then always finds its hand-off, committed with it. */
function readPointerFacts(sessionId: string): Promise<StructuredPointerFacts | null> {
  return readSession(sessionId, async (host) => {
    const rows = await host.queuedMessageRows(sessionId)
    return {
      submissions: (await host.journalSnapshot(sessionId)).submissions,
      cards: rows.map(({ messageId, state, source, settledByOp }) => ({
        messageId,
        state,
        notice:
          source.kind === 'agent' && source.orchestration.message === 'mail-notice'
            ? {
                mailbox: source.orchestration.mailbox,
                messageIds: source.orchestration.messageIds
              }
            : null,
        // Only an operation someone asked for stamps the card; the host's own withdrawals do not.
        withdrawnByRequest: state === 'withdrawn' && settledByOp !== null
      }))
    }
  })
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

function currentFence(sessionId: string): number | null {
  return (
    getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null
  )
}

export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  return {
    readFacts(sessionId) {
      return readPointerFacts(sessionId)
    },

    currentFence,

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
          // A busy chat holds the pointer as a card in its own queue, not shown, which sends it when
          // the turn ends: sent mid-turn, Codex coalesces it into the running turn and Claude folds
          // it in, so it would read as part of that work rather than a new instruction.
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
          return { kind: 'queued', state: outcome.queued.state }
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
