// A send's queue step around its immediate path: the queue decision before it. A
// person's send lifts a paused queue through its recorded origin once its turn
// starts (`structured-agent-session-queued-pause.ts`), not through anything here.

import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { maybeQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { conversationOperationWaitRefusal } from './structured-conversation-command-lane'

export async function runQueueableStructuredAgentSessionSend(
  context: StructuredAgentSessionMutationContext,
  ctx: AgentSessionTurnContext,
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
    userSend?: true
    draftOnly?: true
  },
  immediate: () => Promise<TurnOutcome<AgentSessionSendResult>>
): Promise<TurnOutcome<AgentSessionSendResult>> {
  // The queue decision runs first: a capable send during a transient hold
  // (a /compact in flight — the command controller lets it through) queues
  // rather than being refused; only a `blocked` hold — which never queues —
  // falls through to the refusal.
  const queued = await maybeQueueStructuredAgentSessionSend(context, ctx, params)
  if (queued) {
    return queued
  }
  if (params.draftOnly) {
    return conversationOperationWaitRefusal()
  }
  const accepted = await immediate()
  if (accepted.ok) {
    context.wakeDelivery(ctx.sessionId)
  }
  return accepted
}
