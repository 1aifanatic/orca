// A provider child's close: one per child, joined by every stop, start and provider write that
// meets it, and the one place a close's proven exit ends the child's record.
//
// The close lives on the child (`child.close`) and ends with it, so nothing outlives the process
// it is about. A caller waits a bounded time for the exit's proof; past the bound it answers
// `unverifiable` and the close keeps running. Whenever the exit is proven — by a caller still
// waiting, or by the adapter's own report of it — the record ends here.

import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS
} from './structured-agent-session-eviction'
import {
  STRUCTURED_AGENT_SESSION_EVICTION_STEP_TIMEOUT_MS,
  withStructuredAgentSessionEvictionDeadline
} from './structured-agent-session-eviction-deadline'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionChildClose,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { endProviderChild } from './structured-agent-session-provider-child'
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'
import { releaseStoredStructuredAgentSessionOwner } from './structured-agent-session-lease-release'
import { settleStructuredAgentSessionDeadGeneration } from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import { isSurfaceReleasableAgentSessionRecord } from '../../runtime/agent-session-surface-release-transition'

/** What a caller learned about the child's exit: proven, or not within its bound. Loss of contact
 *  and a close that ran out of its own escalation both read `unverifiable`, never `exited`. */
export type StructuredAgentSessionChildCloseVerdict = 'exited' | 'unverifiable'

/** Joins the child's close, starting another attempt when the last one ended unproven, and waits
 *  for its proof as long as the caller may. A proof ends the record before this resolves. */
export async function joinStructuredAgentSessionChildClose(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  child: StructuredAgentSessionProviderChild,
  close: StructuredAgentSessionChildClose
): Promise<StructuredAgentSessionChildCloseVerdict> {
  close.attempt ??= closeAttempt(context, sessionId, close)
  const proven = await withTimeout(
    close.attempt,
    STRUCTURED_AGENT_SESSION_EVICTION_STEP_TIMEOUT_MS,
    false
  )
  if (!proven) {
    return 'unverifiable'
  }
  await endClosedStructuredAgentSessionChildUnderSerialize(context, sessionId, child)
  return 'exited'
}

/** The refusal of an operation that met a child whose close is still unproven. */
export function previousExitUnverifiableRefusal(): AgentSessionWireRefusal {
  return refuse(
    'agent_session_ownership_unknown',
    { reason: 'previousExitUnverifiable', ownerVerdict: 'unverifiable' },
    "Orca could not prove this chat's previous agent process exited."
  )
}

/** For an operation that reaches the provider: a child a stop began closing takes no input and
 *  none may start beside it, so the operation joins that close and is refused while it is still
 *  unproven. */
export async function joinClosingStructuredAgentSessionChild(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<{ ok: true } | { ok: false; refusal: AgentSessionWireRefusal }> {
  const child = context.sessions.get(sessionId)?.child
  if (!child?.close) {
    return { ok: true }
  }
  return (await joinStructuredAgentSessionChildClose(context, sessionId, child, child.close)) ===
    'exited'
    ? { ok: true }
    : { ok: false, refusal: previousExitUnverifiableRefusal() }
}

function closeAttempt(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  close: StructuredAgentSessionChildClose
): Promise<boolean> {
  const { adapter, logger } = context.deps
  // An adapter with no close has nothing to stop; anything else must PROVE the exit.
  const stop = adapter.disposeSession ?? adapter.closeSession
  const attempt = (
    stop
      ? stopAgentSessionProviderRoot(
          () => stop.call(adapter, sessionId),
          // The exit is proven; a child process left behind, or a write after it, is reported only.
          (error) =>
            logger.warn("the agent's process exited, but its close did not finish cleanly", {
              scope: 'provider-close-after-exit',
              sessionId,
              error
            })
        )
      : Promise.resolve(true)
  ).catch((error: unknown) => {
    logger.warn("closing the agent's process did not prove it exited", {
      scope: 'provider-close',
      sessionId,
      error
    })
    return false
  })
  // Unproven, the next ask starts another attempt. A proof that lands after every caller stopped
  // waiting needs nothing here: the adapter reports that exit, which ends the record.
  void attempt.then((proven) => {
    if (!proven && close.attempt === attempt) {
      close.attempt = undefined
    }
  })
  return attempt
}

/** Whether the lease still names the child this host last proved gone, unreleased: only that
 *  in-memory proof lets this host release it without a probe, so the handle carrying it stays. */
export function structuredAgentSessionEndedChildHoldsLease(
  context: Pick<StructuredAgentSessionLifetimeContext, 'deps' | 'sessions'>,
  sessionId: string
): boolean {
  const ended = context.sessions.get(sessionId)?.lastEndedChild
  const record = context.deps.store.getRecord(sessionId)
  return (
    ended?.rootGone === true &&
    record !== null &&
    isSurfaceReleasableAgentSessionRecord(record) &&
    record.lease.runtimeFence === ended.fence
  )
}

/** Writes the release a proven exit allows when its wind-down could not: a start and the
 *  handle's close re-derive it, and a failure is reported, never anyone's refusal. Resolves
 *  whether the lease still names that child. */
export async function releaseLeaseOfEndedStructuredAgentSessionChild(
  context: Pick<StructuredAgentSessionLifetimeContext, 'deps' | 'sessions' | 'now'>,
  sessionId: string
): Promise<boolean> {
  const ended = context.sessions.get(sessionId)?.lastEndedChild
  if (!ended || !structuredAgentSessionEndedChildHoldsLease(context, sessionId)) {
    return false
  }
  await releaseStoredStructuredAgentSessionOwner({
    store: context.deps.store,
    sessionId,
    hasProviderChild: true,
    expectedFence: ended.fence,
    now: context.now()
  }).catch((error: unknown) =>
    context.deps.logger.warn("releasing an exited agent's lease failed", {
      scope: 'ended-child-lease-release',
      sessionId,
      error
    })
  )
  return structuredAgentSessionEndedChildHoldsLease(context, sessionId)
}

/** The adapter's report that a child it was asked to close is gone ends the record: a proof that
 *  landed with no caller left waiting, or a root that exited after its close gave up. */
export function endClosedStructuredAgentSessionChild(
  context: StructuredAgentSessionLifetimeContext,
  event: StructuredAgentSessionEndedEvent
): Promise<void> {
  return context.serialize(event.sessionId, async () => {
    const child = context.sessions.get(event.sessionId)?.child
    if (child && child.fence === event.fence && child.generation === event.acquisitionGeneration) {
      await endClosedStructuredAgentSessionChildUnderSerialize(context, event.sessionId, child)
    }
  })
}

/** One wind-down per child, which every caller that saw its exit proven awaits. */
const windDowns = new WeakMap<StructuredAgentSessionProviderChild, Promise<void>>()

/**
 * The child's process is proven gone: it leaves the record, then every wind-down step is
 * attempted, each failure reported, none able to keep it on record or gate the next send. Then
 * the delivery loop hands over whatever is queued. Joins the wind-down already running for it.
 */
export function endClosedStructuredAgentSessionChildUnderSerialize(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  child: StructuredAgentSessionProviderChild
): Promise<void> {
  const running = windDowns.get(child)
  if (running) {
    return running
  }
  const session = context.sessions.get(sessionId)
  if (!session || session.child !== child) {
    return Promise.resolve()
  }
  const windDown = windDownClosedChild(context, sessionId, session, child)
  windDowns.set(child, windDown)
  return windDown
}

async function windDownClosedChild(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  child: StructuredAgentSessionProviderChild
): Promise<void> {
  const { deps } = context
  const close = child.close
  endProviderChild(session, {
    generation: child.generation,
    fence: child.fence,
    cause: close?.cause ?? 'evict',
    reason: close?.reason ?? null,
    duringStartup: child.phase === 'starting',
    rootGone: true
  })
  context.restartWitness?.stopped(sessionId)
  await evictStructuredAgentSession(
    {
      sessionId,
      eventSink: context.runtimeState.eventSinkFor(sessionId),
      logger: deps.logger,
      acknowledgeRelease: () => deps.adapter.acknowledgeSessionRelease?.(sessionId),
      discardSink: () => context.runtimeState.discardEventSink(sessionId),
      settleWork: async () => {
        // Folded before the fallback's end is built, so the end reads it (`turnEndAfterStop`).
        await close?.recorded
        const settled = await settleStructuredAgentSessionDeadGeneration({
          journal: session.journal,
          sessionId,
          fence: child.fence,
          settlementId: `expected-close:${sessionId}:${child.fence}:${child.generation ?? 'unknown'}`,
          pendingSubmissionReason: 'provider_closed_before_acknowledgement',
          // Only a turn no adapter settled: one with no close, or whose settle threw. Whether it
          // was a person's Stop is its event's to say (`turnEndAfterStop`).
          verdict: { state: 'interrupted', completedAt: context.now() },
          showUnexpectedExitOutcome: false
        })
        if (!settled.ok) {
          throw new Error('dead generation work settlement failed', { cause: settled.error })
        }
      },
      releaseLease: () =>
        releaseStoredStructuredAgentSessionOwner({
          store: deps.store,
          sessionId,
          hasProviderChild: true,
          expectedFence: child.fence,
          now: context.now()
        })
    },
    withStructuredAgentSessionEvictionDeadline(STRUCTURED_AGENT_SESSION_EVICTION_STEPS)
  )
  // Whatever ended the child, the row belongs to the conversation: it shows not-running, and only
  // the conversation's close forgets it.
  context.publishStatus?.(sessionId)
  context.wakeDelivery?.(sessionId)
}
