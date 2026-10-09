// `/clear` under the session's serialize: the agent stopped, then a fresh provider context committed
// in the same conversation. The command RPC runs it at once, and the queue runs a /clear card when
// its turn comes; neither ever hands it to the agent.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  agentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import {
  providerContextBoundaryForClear,
  type AgentSessionConversationClear
} from '../../runtime/agent-session-conversation-command-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import { returnUnsentQueuedCard } from '../agent-session-journal/queued-message-return'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { TurnOutcome } from './structured-agent-session-turns'
import {
  conversationCommandBlocked,
  type ConversationCommandAdmissionContext
} from './structured-conversation-command-admission'

export const STRUCTURED_AGENT_SESSION_CLEAR_COMMAND = 'clear'

/** Who a clear the queue ran is recorded as: no client pressed it then, and which one queued it
 *  is not kept, so no caller's later /clear replays it. */
export const QUEUED_CLEAR_CALLER_KEY = 'orca:queued-clear'

/** What the user sent for `/clear`, as its card shows it. */
export function structuredAgentSessionClearBody(): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: '/clear' }],
    command: { name: STRUCTURED_AGENT_SESSION_CLEAR_COMMAND }
  }
}

export function isQueuedClearCard(card: Pick<QueuedMessageRow, 'body'>): boolean {
  return card.body.command?.name === STRUCTURED_AGENT_SESSION_CLEAR_COMMAND
}

export type ConversationClearContext = ConversationCommandAdmissionContext & {
  journal: AgentSessionJournal
}

/**
 * Refused while anything it would cut off is in flight; else the agent is stopped, admission is
 * read again at the stop's fence, and `commit` writes the clear. A refusal or a throw before the
 * commit changed nothing.
 */
export async function clearConversationUnderSerialize(
  context: StructuredAgentSessionMutationContext,
  ctx: ConversationClearContext,
  marker: { operationId: string; callerKey: string },
  commit: (clear: AgentSessionConversationClear) => Promise<unknown>
): Promise<TurnOutcome<AgentSessionConversationClear['command']>> {
  const { sessionId } = ctx
  const store = context.deps.store
  const blocked = conversationCommandBlocked(
    ctx,
    store.getRecord(sessionId)!,
    context.readChildWork(sessionId),
    context.sessions.get(sessionId)?.child ? undefined : 'at-rest'
  )
  if (blocked) {
    return { ok: false, refusal: blocked }
  }
  await context.stopAgent(sessionId, { cause: 'context-clear' })
  const stopped = store.getRecord(sessionId)!
  const fence = stopped.lease.runtimeFence
  const rechecked = conversationCommandBlocked(
    { ...ctx, fence },
    stopped,
    context.readChildWork(sessionId),
    'at-rest'
  )
  if (rechecked) {
    return { ok: false, refusal: rechecked }
  }
  const command: AgentSessionConversationClear['command'] = {
    command: 'clear',
    runtimeFence: fence,
    ...marker,
    phase: 'committed',
    state: 'completed'
  }
  await commit({ sessionId, fence, command, now: context.now() })
  return { ok: true, value: command }
}

/** Refusals that end on their own: the card keeps waiting, and the drain runs it once they end
 *  (it wakes on child work and on a handoff ending), as it waits for a turn. */
const WAITS_FOR = new Set(['backgroundTasksRunning', 'handoffInFlight'])

export type QueuedClearOutcome =
  | { kind: 'cleared' }
  /** Still waiting, on something that ends on its own; nothing was written. */
  | { kind: 'waiting'; refusal: AgentSessionWireRefusal }
  | { kind: 'returned' }

/**
 * A /clear card's turn, from the drain or the card's own Send, inside the session's serialize. The
 * card is spent in the clear's own transaction, so it runs once. Refused for a wait it stays
 * waiting; refused otherwise, or failed before its commit, the card is returned with why (the card
 * is where that is said, once), and the cards behind it wait: they were written for the cleared chat.
 */
export async function runQueuedConversationClear(
  context: StructuredAgentSessionMutationContext,
  ctx: ConversationClearContext,
  card: Pick<QueuedMessageRow, 'messageId'>,
  /** The card's receipt: the drain's own key, or the Send that ran it. */
  settledByOp: string
): Promise<QueuedClearOutcome> {
  let fact = agentSessionFailureFact('commandRefused')
  try {
    const cleared = await clearConversationUnderSerialize(
      context,
      ctx,
      { operationId: card.messageId, callerKey: QUEUED_CLEAR_CALLER_KEY },
      (clear) =>
        ctx.journal.context.clear(
          providerContextBoundaryForClear(clear),
          context.deps.store.conversationReceipts.queuedClear(() => clear),
          settledByOp,
          card.messageId
        )
    )
    if (cleared.ok) {
      return { kind: 'cleared' }
    }
    const { details } = cleared.refusal
    const reason = details && 'reason' in details ? details.reason : undefined
    if (reason !== undefined && WAITS_FOR.has(reason)) {
      return { kind: 'waiting', refusal: cleared.refusal }
    }
    fact = agentSessionFailureFact('commandRefused', {
      refusal: agentSessionRefusalReference(cleared.refusal)
    })
  } catch (error) {
    context.deps.logger.warn('running a queued /clear failed', {
      scope: 'queued-clear',
      sessionId: ctx.sessionId,
      error
    })
  }
  const words = agentSessionFailureWords(fact, { command: 'clear', surface: 'rejection' })
  await returnUnsentQueuedCard(ctx.journal.queuedMessages, {
    messageId: card.messageId,
    reason: words.reason,
    rejection: words.rejection,
    now: context.now()
  })
  return { kind: 'returned' }
}
