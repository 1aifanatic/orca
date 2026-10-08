// `/clear` under the session's serialize: one write that points this conversation at a new,
// at-rest one and moves its tab there. The command RPC runs it at once, and the queue runs it when
// a /clear card's turn comes; neither ever hands it to the agent.

import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { randomBytes } from 'node:crypto'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentSessionConversationCommandRecord } from '../../../shared/agent-session-conversation-command'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  agentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import { returnUnsentQueuedCard } from '../agent-session-journal/queued-message-holds'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import {
  commitClearWithQueuedMessages,
  STRUCTURED_AGENT_SESSION_CLEAR_COMMAND
} from './structured-conversation-clear-carry'

/** Who a clear the queue ran is recorded as: no person pressed it at that moment, and which
 *  client queued it is not kept, so no caller's later /clear replays it. */
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

type ClearContext = Pick<
  AgentSessionTurnContext,
  'sessionId' | 'journal' | 'fence' | 'adapter' | 'logger'
>

/**
 * The clear itself: refused while anything it would cut off is in flight, else the agent is
 * stopped, the clear and carried drafts commit together. `operationId` is what the marker
 * records — for a /clear card, the card's id, which is how a reopen finds the card it ran from.
 */
export async function clearConversationUnderSerialize(
  context: StructuredAgentSessionMutationContext,
  ctx: ClearContext,
  clear: { operationId: string; callerKey: string }
): Promise<TurnOutcome<AgentSessionConversationCommandRecord & { replacementSessionId: string }>> {
  const { sessionId } = ctx
  const store = context.deps.store
  const record = store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_record_missing')
  }
  const blocked = conversationCommandBlocked(
    ctx,
    record,
    context.readChildWork(sessionId),
    context.sessions.get(sessionId)?.child ? undefined : 'at-rest'
  )
  if (blocked) {
    return { ok: false, refusal: blocked }
  }
  // Stopped before the marker, so nothing the old agent does can land after the clear. The
  // stop releases the lease, which moves its fence: the marker is written at the new one.
  // A /clear replaces this chat: the user closing it.
  await context.stopAgent(sessionId, { cause: 'user-close' })
  const fence = store.getRecord(sessionId)!.lease.runtimeFence
  const completed = {
    command: 'clear' as const,
    runtimeFence: fence,
    operationId: clear.operationId,
    callerKey: clear.callerKey,
    // Only has to be new: the marker is what points at it, and a same-id resend replays it.
    replacementSessionId: `clear-${randomBytes(20).toString('hex')}`,
    phase: 'committed' as const,
    state: 'completed' as const
  }
  const clearRecord = {
    sessionId,
    fence,
    command: completed,
    claimKeyId: context.deps.claimKeyId,
    now: context.now()
  }
  // The fresh destination cannot be observed until all its carried work is committed.
  await context.serialize(completed.replacementSessionId, async () => {
    const carried = await commitClearWithQueuedMessages(ctx, {
      replacement: foundAgentSessionRecord(
        { ...record, sessionId: completed.replacementSessionId },
        clearRecord
      ),
      stateDirectory: context.deps.journalDatabase.stateDirectory,
      callerKey: clear.callerKey,
      operationId: clear.operationId,
      now: clearRecord.now,
      receipt: store.commitConversationClearReceipt(clearRecord)
    })
    if (!carried) {
      return
    }
    try {
      await context.openConversation(completed.replacementSessionId, { freshClear: true })
    } catch (error) {
      ctx.logger.warn('opening a cleared conversation failed', {
        scope: 'clear-open',
        sessionId: completed.replacementSessionId,
        error
      })
    }
  })
  return { ok: true, value: completed }
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
 * A /clear card's turn, from the drain or the card's own Send, inside the session's serialize.
 * Refused for a wait (background tasks, a handoff) it stays waiting. Refused otherwise, or failed
 * before its commit (which changed nothing), the card is returned with why — the card is where
 * that is said, once — and the cards behind it wait: they were written for the cleared chat.
 */
export async function runQueuedConversationClear(
  context: StructuredAgentSessionMutationContext,
  ctx: ClearContext,
  card: Pick<QueuedMessageRow, 'messageId'>
): Promise<QueuedClearOutcome> {
  let fact = agentSessionFailureFact('commandRefused')
  try {
    const cleared = await clearConversationUnderSerialize(context, ctx, {
      operationId: card.messageId,
      callerKey: QUEUED_CLEAR_CALLER_KEY
    })
    if (cleared.ok) {
      return { kind: 'cleared' }
    }
    const reason = cleared.refusal.details?.reason
    if (reason !== undefined && WAITS_FOR.has(reason)) {
      return { kind: 'waiting', refusal: cleared.refusal }
    }
    fact = agentSessionFailureFact('commandRefused', {
      refusal: agentSessionRefusalReference(cleared.refusal)
    })
  } catch (error) {
    ctx.logger.warn('running a queued /clear failed', {
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
