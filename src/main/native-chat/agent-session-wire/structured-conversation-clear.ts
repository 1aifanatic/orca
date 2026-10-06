// `/clear` under the session's serialize: one write that points this conversation at a new,
// at-rest one and moves its tab there. The command RPC runs it at once, and the queue runs it when
// a /clear card's turn comes; neither ever hands it to the agent.

import { randomBytes } from 'node:crypto'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentSessionConversationCommandRecord } from '../../../shared/agent-session-conversation-command'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import {
  carryQueuedMessagesToClearReplacement,
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
 * stopped, the clear is committed, and the drafts are carried. `operationId` is what the marker
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
  await store.commitConversationClear({
    sessionId,
    fence,
    command: completed,
    claimKeyId: context.deps.claimKeyId,
    now: context.now()
  })
  await carryQueuedMessagesToClearReplacement(ctx, {
    replacementSessionId: completed.replacementSessionId,
    // Opened under its own lock, as every open is.
    openReplacementJournal: async () =>
      (await context.conversation(completed.replacementSessionId)).journal,
    callerKey: clear.callerKey,
    operationId: clear.operationId
  })
  return { ok: true, value: completed }
}

/**
 * A /clear card's turn, from the drain or the card's own Send, inside the session's serialize.
 * True once the clear committed. Refused, or failed before its commit (which changed nothing),
 * the card is returned with why — the card is where that is said, once — and the cards behind it
 * wait: they were written for the cleared chat.
 */
export async function runQueuedConversationClear(
  context: StructuredAgentSessionMutationContext,
  ctx: ClearContext,
  card: Pick<QueuedMessageRow, 'messageId'>
): Promise<boolean> {
  let fact = agentSessionFailureFact('commandRefused')
  try {
    const cleared = await clearConversationUnderSerialize(context, ctx, {
      operationId: card.messageId,
      callerKey: QUEUED_CLEAR_CALLER_KEY
    })
    if (cleared.ok) {
      return true
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
  await ctx.journal.queuedMessages.returnUnsent({
    messageId: card.messageId,
    reason: words.reason,
    rejection: words.rejection
  })
  return false
}
