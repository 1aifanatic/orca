// Stop's queued-draft steps around the interrupt: hold the withdrawable
// frontier first, then — for a capable client — withdraw it and hand the text
// back, stamped with the Stop's caller-scoped key so a replay answers from the
// tombstones. Every write here goes through the draft store, whose commit
// notification publishes and wakes the drain; nothing publishes by hand.

import type { AgentSessionWithdrawnQueuedMessage } from '../../../shared/agent-session-wire'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import {
  withdrawableQueuedMessages,
  withdrawQueuedMessagesForOperation
} from './structured-agent-session-queued-mutations'

/** Stop step (1): hold the withdrawable frontier at the serialized stop step —
 *  sends accepted after it are new work. Stored on the rows, so it survives
 *  eviction and restart; bookkeeping never gates the Stop. */
async function holdWithdrawableQueuedMessages(
  ctx: AgentSessionTurnContext
): Promise<QueuedMessageRow[]> {
  let frontier: QueuedMessageRow[]
  try {
    frontier = withdrawableQueuedMessages(ctx.journal)
  } catch {
    return []
  }
  try {
    await ctx.journal.queuedMessages.hold({
      messageIds: frontier.filter((row) => row.state === 'waiting').map((row) => row.messageId),
      reason: 'stopped'
    })
  } catch {
    // A failed hold must not shrink what a capable Stop withdraws.
  }
  return frontier
}

/** Stop step (3): compare-and-transition the frontier, one transaction stamped
 *  with the Stop's caller-scoped key, returning the bodies — returned cards'
 *  text included, and a consumed draft's whose submission this Stop withdrew.
 *  Failure leaves the drafts held and visible (the hold already published);
 *  the Stop itself still succeeded, so nothing here may throw. */
async function settleStopQueuedWithdrawal(
  ctx: AgentSessionTurnContext,
  input: {
    operationId: string
    frontier: readonly QueuedMessageRow[]
  }
): Promise<{ withdrawnQueued: AgentSessionWithdrawnQueuedMessage[] } | Record<string, never>> {
  try {
    // The frontier, plus the cards this Stop itself returned: a consumed draft
    // whose submission it withdrew before the agent received it. Nothing else
    // can add a draft inside the Stop's serialized step.
    const messageIds = new Set(input.frontier.map((row) => row.messageId))
    for (const row of withdrawableQueuedMessages(ctx.journal)) {
      if (row.state === 'returned') {
        messageIds.add(row.messageId)
      }
    }
    const withdrawnQueued = await withdrawQueuedMessagesForOperation(ctx.journal, {
      sessionId: ctx.sessionId,
      messageIds: [...messageIds],
      callerKey: ctx.resolvedBy,
      operationId: input.operationId
    })
    return { withdrawnQueued }
  } catch {
    return {}
  }
}

/**
 * The two Stop steps around the interrupt, packaged for the cancel path: hold
 * the withdrawable frontier NOW (the drain must not send a draft the user is
 * stopping), and hand back the finisher that withdraws it after the interrupt —
 * only when the capable client asked (`withdrawQueued`); an old-client Stop is
 * hold + interrupt alone, and a consumed draft it withdrew stays a returned card.
 */
export async function stopQueuedWithdrawalFinisher(
  ctx: AgentSessionTurnContext,
  input: {
    withdrawQueued: true | undefined
    operationId: string
  }
): Promise<<TValue extends object>(value: TValue) => Promise<{ ok: true; value: TValue }>> {
  const frontier = await holdWithdrawableQueuedMessages(ctx)
  return async (value) => {
    if (!input.withdrawQueued) {
      return { ok: true, value }
    }
    return {
      ok: true,
      value: {
        ...value,
        ...(await settleStopQueuedWithdrawal(ctx, {
          operationId: input.operationId,
          frontier
        }))
      }
    }
  }
}
