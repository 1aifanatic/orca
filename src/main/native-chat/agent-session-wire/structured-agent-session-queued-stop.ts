// Stop's queued-draft steps around the interrupt: pause the withdrawable
// frontier first, then — for a capable client — withdraw it and hand the text
// back, stamped with the Stop's caller-scoped key so a replay answers from the
// tombstones.

import type { AgentSessionWithdrawnQueuedMessage } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import {
  withdrawableQueuedMessages,
  withdrawQueuedMessagesForOperation
} from './structured-agent-session-queued-mutations'
import { pauseQueuedMessage } from './structured-agent-session-queued-pause'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

/** Stop step (1): pause the withdrawable frontier at the serialized stop step —
 *  sends accepted after it are new work. Bookkeeping never gates the Stop. */
function pauseWithdrawableQueuedMessages(
  journal: AgentSessionJournal,
  sessionId: string
): QueuedMessageRow[] {
  try {
    const frontier = withdrawableQueuedMessages(journal)
    for (const row of frontier) {
      pauseQueuedMessage(sessionId, row.messageId)
    }
    return frontier
  } catch {
    return []
  }
}

/** Stop step (3): compare-and-transition the frontier, one transaction stamped
 *  with the Stop's caller-scoped key, returning the bodies — returned cards'
 *  text included, and a consumed draft's whose submission this Stop withdrew.
 *  Failure leaves the drafts paused and visible; the Stop itself still
 *  succeeded, so nothing here may throw. */
async function settleStopQueuedWithdrawal(
  ctx: AgentSessionTurnContext,
  input: {
    operationId: string
    frontier: readonly QueuedMessageRow[]
    wake?: ((sessionId: string) => void) | undefined
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
    ctx.publish()
    input.wake?.(ctx.sessionId)
    return { withdrawnQueued }
  } catch {
    return {}
  }
}

/**
 * The two Stop steps around the interrupt, packaged for the cancel path: pause
 * the withdrawable frontier NOW (the drain must not send a draft the user is
 * stopping), and hand back the finisher that withdraws it after the interrupt —
 * only when the capable client asked (`withdrawQueued`); an old-client Stop is
 * pause + interrupt alone, and a consumed draft it withdrew stays a returned card.
 */
export function stopQueuedWithdrawalFinisher(
  ctx: AgentSessionTurnContext,
  input: {
    withdrawQueued: true | undefined
    operationId: string
    wake?: ((sessionId: string) => void) | undefined
  }
): <TValue extends object>(value: TValue) => Promise<{ ok: true; value: TValue }> {
  const frontier = pauseWithdrawableQueuedMessages(ctx.journal, ctx.sessionId)
  return async (value) =>
    input.withdrawQueued
      ? {
          ok: true,
          value: {
            ...value,
            ...(await settleStopQueuedWithdrawal(ctx, {
              operationId: input.operationId,
              frontier,
              wake: input.wake
            }))
          }
        }
      : { ok: true, value }
}
