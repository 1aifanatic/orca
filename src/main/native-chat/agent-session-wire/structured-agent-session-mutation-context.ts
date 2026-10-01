// The context every client mutation of a session runs with, and the one path each takes: admit the
// envelope against the lease, then run its plan inside the session's serialize.

import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  admitAndRunAgentSessionMutation,
  refuseAgentSessionMutation,
  type AgentSessionMutationRequest,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import { structuredAgentSessionOperationStartOutcome } from './structured-agent-session-agent-start'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type StructuredAgentSessionMutationContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  publish: (sessionId: string, journal: StructuredAgentSessionHostSession['journal']) => void
  flushStreamedEvents: (sessionId: string) => Promise<void>
  /** The host's accessor, for a caller outside the session's serialize. */
  conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
  /** The session's child records, as the strip reads them; what command admission decides on. */
  readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The session's conversation, opened when closed; inside the caller's serialize. */
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  /** Gives the session a provider child; inside the caller's serialize. */
  ensureAgent: (sessionId: string) => Promise<AgentSessionMutationSessionPreparation>
  /** A message was accepted: the session's delivery loop hands it over. */
  wakeDelivery: (sessionId: string) => void
  /** Stops the session's provider child, keeping its conversation; inside the caller's serialize. */
  stopAgent: (sessionId: string) => Promise<void>
  /** Only for gate inputs living in the RECORD store, which can settle with no
   *  journal commit (a conversation command). Draft-table changes need no call:
   *  the draft store notifies through the journal's own commit listener. */
  wakeQueuedDrain?: (sessionId: string) => void
  now: () => number
}

/** A preparation found the agent the call needs still proving its start: the call leaves the queue
 *  to wait for it. */
class AwaitingAgentStart {
  constructor(readonly child: string) {}
}

/** Waits out a start this many times outside the queue before waiting on it inside. */
const OUTSIDE_START_WAITS = 2

/** Admits the envelope and runs the plan inside the session's serialize. A start the preparation
 *  makes is waited on outside the queue, as the delivery loop waits, so a Stop or the idle sweep
 *  can reach a start that hangs; the call then re-enters, finding that child there. */
export async function mutateStructuredAgentSession<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<TValue>,
  prepareSession?: AgentSessionMutationRequest<TValue>['prepareSession']
): Promise<AgentSessionMutationResult<TValue>> {
  const { sessionId } = envelope
  const { adapter } = context.deps
  let awaited: string | null = null
  for (let waits = 0; ; waits += 1) {
    const prepare: typeof prepareSession =
      prepareSession &&
      (async (decision, record) => {
        const prepared = await prepareSession(decision, record)
        const child = context.sessions.get(sessionId)?.child
        if (!prepared.ok || !prepared.startPending || !child || !adapter.awaitStarted) {
          return prepared
        }
        const identity = `${child.generation}:${child.fence}`
        if (identity !== awaited && waits < OUTSIDE_START_WAITS) {
          throw new AwaitingAgentStart(identity)
        }
        // Already settled for the child waited on: the host's phase trails the adapter's by a step.
        return structuredAgentSessionOperationStartOutcome(await adapter.awaitStarted(sessionId))
      })
    try {
      return await context.serialize(sessionId, () =>
        admitAndRunAgentSessionMutation({
          store: context.deps.store,
          adapter,
          callerKey: caller.callerKey,
          envelope,
          plan,
          journal: () => context.sessions.get(sessionId)?.journal,
          prepareSession: prepare,
          publish: (journal) => context.publish(sessionId, journal),
          flushStreamedEvents: context.flushStreamedEvents,
          providerChildPhase: () => context.sessions.get(sessionId)?.child?.phase,
          now: () => context.now()
        })
      )
    } catch (error) {
      if (!(error instanceof AwaitingAgentStart)) {
        throw error
      }
      const started = structuredAgentSessionOperationStartOutcome(
        await adapter.awaitStarted?.(sessionId)
      )
      if (!started.ok) {
        return refuseAgentSessionMutation(started.refusal)
      }
      awaited = error.child
    }
  }
}
