// The chat's Stop, however a client reached it: the Stop button, a question card's Cancel, or an
// approval card's Stop option. One body and one order: withdraw what is queued, record where the
// Stop took effect, interrupt, then end the child in the next step on the session's lane.

import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { runStopWithQueuePause } from './structured-agent-session-queued-stop'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import {
  endStoppedStructuredAgentSession,
  isMainAgentWorkingOnceFlushed,
  performCancel,
  type StructuredAgentSessionStopWindDown
} from './structured-agent-session-turns-cancel'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export type StructuredAgentSessionChatStop = {
  /** The Stop's step, run inside the caller's mutation. */
  run: (ctx: AgentSessionTurnContext) => Promise<TurnOutcome<AgentSessionCancelResult>>
  /** Queues the step that ends the child. Call it in the same tick as the mutation, so nothing sent
   *  meanwhile reaches that child; it does nothing unless the Stop ended the provider's session. */
  queueChildEnd: () => void
}

export function structuredAgentSessionChatStop(
  context: StructuredAgentSessionMutationContext,
  envelope: AgentSessionMutationEnvelope,
  turnId?: string
): StructuredAgentSessionChatStop {
  const { sessionId } = envelope
  // Set by the Stop's step only when its provider's session ends; a replay leaves it unset.
  let windDown: StructuredAgentSessionStopWindDown | undefined
  const named = turnId !== undefined ? { turnId } : {}
  return {
    // Stop's queue step, the same for every client: once the Stop takes effect the queue is
    // paused. The cards stay published; nothing is withdrawn and no text ever rides the answer.
    run: (ctx) =>
      runStopWithQueuePause(ctx, async (tookEffect) => {
        // Stop withdraws every queued SUBMISSION first, whatever the start or the child is doing.
        const withdrawn = await ctx.journal.rejectQueuedSubmissions(
          ctx.fence,
          agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
        )
        const child = context.sessions.get(ctx.sessionId)?.child
        if (child?.phase === 'starting') {
          // A start that may never land is the one thing here Stop has to end; the chat stays.
          await tookEffect()
          await context.stopAgent(ctx.sessionId)
          return { ok: true, value: { ...named, cancelled: true } }
        }
        // A Stop naming no turn ends nothing more unless the session reads working, by the rule
        // every session list and the chat's own Stop read it.
        const inFlight = turnId !== undefined || (await isMainAgentWorkingOnceFlushed(ctx))
        const record = context.deps.store.getRecord(ctx.sessionId)
        if (!child || !inFlight) {
          if (withdrawn.length > 0) {
            await tookEffect()
          }
          return { ok: true, value: { ...named, cancelled: withdrawn.length > 0 } }
        }
        await tookEffect()
        return performCancel(
          { ...ctx, failureTextContext: structuredAgentSessionFailureWordsContext(record) },
          {
            clientOperationId: envelope.clientOperationId,
            ...named,
            stopChild: () => context.stopAgent(sessionId),
            endSession: (owed) => {
              windDown = owed
            },
            withdrewQueued: withdrawn.length > 0
          }
        )
      }),
    queueChildEnd: () =>
      void context.serialize(sessionId, async () => {
        if (windDown) {
          await endStoppedStructuredAgentSession(
            { sessionId, adapter: context.deps.adapter },
            windDown,
            () => context.stopAgent(sessionId),
            (error) => context.deps.onEventSinkError?.({ sessionId, error })
          )
        }
      })
  }
}
