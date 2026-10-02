// What a host does once its provider child is gone: the bookkeeping that hands the session back.
//
// Teardown is a DATA list, not a method body, for the reason this file exists at all: the host
// tracked which sessions were live in a map, and tore them down at three unrelated call sites
// (app quit, handoff to a TUI, and error cleanup). Closing a chat was never wired to any of them,
// so a provider child outlived the chat that owned it for the whole app session.
//
// ORDER. These run only after the child's exit is proven (`structured-agent-session-child-close`).
// Closing it is not silent: the codex adapter emits its `ended` event and flushes coalesced text as
// part of shutting down, and those are the rows that clear the running-turn marker. Draining or
// closing the sink ahead of that drops them, which leaves the durable journal claiming the agent is
// still working. So: drain what the child emitted on its way out, settle, then let the sink go.
//
// FAILURE. Each step is bookkeeping for a process already gone, so a step that fails is reported
// and the rest still run: none of them may keep a dead child on record or gate the next send.

import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentSessionEvictionContext = {
  sessionId: string
  eventSink: DeferredStructuredAgentSessionEventSink
  logger: StructuredAgentSessionLogger
  /** Tells the adapter the released lease is done with, so it drops this child's route and index.
   *  The conversation stays: stopping the agent never closes its journal. */
  acknowledgeRelease: () => Promise<void> | void
  /** Drops the cached sink so a later attach mints a fresh one. */
  discardSink: () => void
  /** Settles work owned by the child after its final callbacks have drained. */
  settleWork: () => Promise<void>
  /** Hands the lease back now that this host's child is proven gone. No-ops when the record is
   *  not this host's to release. */
  releaseLease: () => Promise<void>
}

/** The resume offer is advisory; a stalled sink must not hold the child's stop behind it. */
export const SNAPSHOT_DRAIN_TIMEOUT_MS = 1_000

export type StructuredAgentSessionEvictionStep = {
  name: string
  run: (context: StructuredAgentSessionEvictionContext) => Promise<void> | void
}

/** Quit's resume offer: what the sidebar shows, read while the child is still running. Events the
 *  provider already delivered are part of what it showed at the stop. A throw is logged. */
export async function snapshotBeforeStructuredAgentSessionStop(
  context: Pick<StructuredAgentSessionEvictionContext, 'sessionId' | 'eventSink' | 'logger'>,
  snapshot: () => void
): Promise<void> {
  await withTimeout<unknown>(context.eventSink.drained(), SNAPSHOT_DRAIN_TIMEOUT_MS, null)
  try {
    snapshot()
  } catch {
    context.logger.warn('capturing a recovery witness before a stop failed', {
      scope: 'recovery-witness',
      sessionId: context.sessionId
    })
  }
}

export const STRUCTURED_AGENT_SESSION_EVICTION_STEPS: readonly StructuredAgentSessionEvictionStep[] =
  [
    {
      name: 'drain-published',
      run: async (context) => {
        const barrier = await context.eventSink.drained()
        if (!barrier.ok) {
          throw barrier.error
        }
      }
    },
    { name: 'settle-dead-generation', run: (context) => context.settleWork() },
    { name: 'stop-publishing', run: (context) => context.eventSink.unbind() },
    { name: 'close-sink', run: (context) => context.eventSink.close() },
    // Why: the runtime caches one sink per session id and hands the SAME instance to the next
    // attach. Closing without discarding leaves a reopened chat bound to a closed sink, which
    // accepts every provider event and publishes none. Attach's own failure path already pairs
    // these two; eviction has to as well.
    { name: 'discard-sink', run: (context) => context.discardSink() },
    // The durable lease still names a process this host just proved gone; a start re-derives the
    // release from that proof if this write fails.
    { name: 'release-lease', run: (context) => context.releaseLease() },
    { name: 'acknowledge-release', run: (context) => context.acknowledgeRelease() }
  ]

export class StructuredAgentSessionEvictionError extends Error {
  constructor(
    readonly step: string,
    readonly sessionId: string,
    override readonly cause: unknown
  ) {
    super(`agent session eviction failed at step "${step}" for ${sessionId}`)
    this.name = 'StructuredAgentSessionEvictionError'
  }
}

/** Runs every wind-down step in order. A failure is reported with the step that failed, and the
 *  rest still run. */
export async function evictStructuredAgentSession(
  context: StructuredAgentSessionEvictionContext,
  steps: readonly StructuredAgentSessionEvictionStep[] = STRUCTURED_AGENT_SESSION_EVICTION_STEPS
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run(context)
    } catch (error) {
      context.logger.warn('a wind-down step after the agent exited failed', {
        scope: 'exit-wind-down',
        sessionId: context.sessionId,
        error: new StructuredAgentSessionEvictionError(step.name, context.sessionId, error)
      })
    }
  }
}
