// The host's half of a session's lifetime: stopping its agent, and closing its conversation.
//
// Two operations, because they end two different things. Stopping the agent ends the provider
// child and hands the lease back; the conversation — its open journal, its status row and its
// readers — stays, and the next send starts a new child. Closing the conversation drops its
// in-memory fold, a cache the next read or write rebuilds from the host's journal database.
//
// Both are written for a caller already inside the session's serialize: the queue is not
// reentrant, so every public entry point takes it once and calls these.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { withStructuredAgentSessionEvictionDeadline } from './structured-agent-session-eviction-deadline'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  endProviderChild,
  structuredAgentSessionConversationFence
} from './structured-agent-session-provider-child'
import { releaseStoredStructuredAgentSessionOwner } from './structured-agent-session-lease-release'
import { settleStructuredAgentSessionDeadGeneration } from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionStopCause } from './structured-agent-session-adapter'
import { isMainAgentWorkingOnceFlushed } from './structured-agent-session-turns-cancel'

export type StructuredAgentSessionLifetimeContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  now: () => number
  /** Re-projects the session's status after its agent stopped and the chat stays. */
  publishStatus?: (sessionId: string) => void
  /** Quit-only snapshot taken immediately before the provider child is stopped. */
  restartWitness?: {
    beforeStop: (sessionId: string) => void
    stopped: (sessionId: string) => void
  }
}

type ConversationCloseDeps = Pick<StructuredAgentSessionHostDeps, 'onEventSinkError'> & {
  store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'>
}

/** A conversation's handle closes with nothing queued: what is still queued when the chat closes,
 *  or the app quits, will not be handed over. Best effort: the next open's delivery loop rejects a
 *  leftover itself. `which` narrows it to the messages a close that did not complete closed.
 *  Resolves false when the rejection failed; the failure is reported, never thrown. */
export async function abandonQueuedStructuredAgentSessionMessages(
  deps: ConversationCloseDeps,
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  which?: (submission: AgentJournalSubmission) => boolean
): Promise<boolean> {
  return journal
    .rejectQueuedSubmissions(
      structuredAgentSessionConversationFence(deps.store, sessionId),
      agentSessionFailureWords(agentSessionFailureFact('chatClosed'), { surface: 'rejection' }),
      which
    )
    .then(
      () => true,
      (error: unknown) => {
        deps.onEventSinkError?.({ sessionId, error })
        return false
      }
    )
}

/** The wind-down this host owes for the session's child. A live child always owes one, whatever a
 *  previous childless eviction recorded: a remembered tombstone must never outrank the child in
 *  front of it. */
function owedProviderChildWindDown(
  session: StructuredAgentSessionHostSession
): StructuredAgentSessionProviderChildIdentity | undefined {
  return session.child
    ? { generation: session.child.generation, fence: session.child.fence }
    : session.owesProviderChildWindDown
}

/** How a stop ends the child, and why (`lastEndedChild`). A person's Stop wrote its event in its
 *  own step (`recorded` names its reason); any other stop names the reason its event records, with
 *  the host's text for it. Quit writes none: its resume marker's trigger records why. */
export type StructuredAgentSessionStopEnding =
  | { recorded: 'user-stop' }
  | {
      cause: Exclude<StructuredAgentSessionStopCause, 'user-stop'>
      reason?: string
      quit?: true
      /** The idle sweep judged the agent resting (`owesWork`): a send it retires unanswered is
       *  no work its event records. */
      resting?: true
    }

/** How long a host stop waits for the session's sink before it judges whether the stop ends work. */
const STOP_EVENT_DRAIN_TIMEOUT_MS = 1_000

/**
 * Whether this stop ends work its event must record: a start, or a running turn or unanswered send
 * read once the sink drained what the provider already said (`isMainAgentWorkingOnceFlushed`). A
 * person's Stop wrote its own event, and quit and the idle sweep's rest write none.
 */
async function stopEndsWork(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  ending: StructuredAgentSessionStopEnding
): Promise<boolean> {
  const { child, journal } = session
  if ('recorded' in ending || ending.quit || ending.resting || !child) {
    return false
  }
  return (
    child.phase === 'starting' ||
    isMainAgentWorkingOnceFlushed(
      {
        journal,
        fence: child.fence,
        flushStreamedEvents: () => context.runtimeState.flushEventSink(sessionId)
      },
      STOP_EVENT_DRAIN_TIMEOUT_MS
    )
  )
}

/** Writes this stop's event (`JournalStopEvent`). Issued before the kill and never awaited by it:
 *  bookkeeping, reported on failure. */
function recordStopEvent(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  ending: StructuredAgentSessionStopEnding
): Promise<void> {
  if ('recorded' in ending) {
    return Promise.resolve()
  }
  const turnId = session.journal.activeTurnId()
  return session.journal
    .appendStopEvent(
      { reason: ending.cause, ...(turnId !== null ? { turnId } : {}) },
      structuredAgentSessionConversationFence(context.deps.store, sessionId)
    )
    .then(
      () => undefined,
      (error: unknown) => context.deps.onEventSinkError?.({ sessionId, error })
    )
}

/**
 * The agent goes to rest; the conversation stays. Runs the eviction steps under a deadline. A step
 * that fails — or runs out of time — aborts the rest and leaves the wind-down owed, so the next
 * stop is a real retry. `ending` is how the child's end is told: a user's Stop, the host stopping it
 * for a cause (with its text), or an eviction the conversation's close follows.
 */
export async function stopStructuredAgentSessionAgentUnderSerialize(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  ending: StructuredAgentSessionStopEnding
): Promise<void> {
  const session = context.sessions.get(sessionId)
  if (!session) {
    return
  }
  // Judged before the kill: a stop that ends nothing writes nothing.
  const recorded = (await stopEndsWork(context, sessionId, session, ending))
    ? recordStopEvent(context, sessionId, session, ending)
    : Promise.resolve()
  // The obligation OUTLIVES the child. `child` is ended the instant the adapter proves the exit,
  // so a step that aborts after that point would otherwise leave the retry reading "no child
  // here" and skipping the settlement and the lease release it still owes.
  const owed = owedProviderChildWindDown(session)
  session.owesProviderChildWindDown = owed
  const stopping = session.child
  let settlementError: unknown
  const eviction: StructuredAgentSessionEvictionContext = {
    sessionId,
    // The retry must not re-stop a child the adapter already proved gone, so this stays honest.
    hasProviderChild: stopping !== null,
    owesProviderChildWindDown: owed !== undefined,
    eventSink: context.runtimeState.eventSinkFor(sessionId),
    adapter: context.deps.adapter,
    ...(context.restartWitness
      ? { beforeProviderChildStop: () => context.restartWitness?.beforeStop(sessionId) }
      : {}),
    // Host state must not disagree with the adapter for the steps in between.
    onProviderChildStopped: (verdict) => {
      if (stopping) {
        endProviderChild(session, {
          generation: stopping.generation,
          fence: stopping.fence,
          cause: 'recorded' in ending ? ending.recorded : ending.cause,
          reason: ('reason' in ending ? ending.reason : undefined) ?? null,
          duringStartup: stopping.phase === 'starting',
          ...verdict
        })
      }
      context.restartWitness?.stopped(sessionId)
    },
    acknowledgeRelease: () => context.deps.adapter.acknowledgeSessionRelease?.(sessionId),
    discardSink: () => context.runtimeState.discardEventSink(sessionId),
    settleWork: async () => {
      // Folded before the fallback's end is built, so the end reads it (`turnEndAfterStop`).
      await recorded
      const fence =
        owed?.fence ?? structuredAgentSessionConversationFence(context.deps.store, sessionId)
      const settled = await settleStructuredAgentSessionDeadGeneration({
        journal: session.journal,
        sessionId,
        fence,
        settlementId: `expected-close:${sessionId}:${fence}:${owed?.generation ?? 'unknown'}`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        // Only a turn no adapter settled: one with no close, or whose settle threw. Whether it was
        // a person's Stop is its event's to say (`turnEndAfterStop`).
        verdict: { state: 'interrupted', completedAt: context.now() },
        showUnexpectedExitOutcome: false,
        onError: (id, error) => {
          settlementError = error
          context.deps.onEventSinkError?.({ sessionId: id, error })
        }
      })
      if (!settled) {
        // Without the cause the log names the step and nothing else.
        throw new Error('dead generation work settlement failed', { cause: settlementError })
      }
    },
    releaseLease: async () => {
      if (owed) {
        await releaseStoredStructuredAgentSessionOwner({
          store: context.deps.store,
          sessionId,
          hasProviderChild: true,
          expectedFence: owed.fence,
          now: context.now()
        })
      }
      session.owesProviderChildWindDown = undefined
      // Whatever ended the child, the row belongs to the conversation: it shows not-running, and
      // only the conversation's close forgets it.
      context.publishStatus?.(sessionId)
    }
  }
  await evictStructuredAgentSession(
    eviction,
    withStructuredAgentSessionEvictionDeadline(STRUCTURED_AGENT_SESSION_EVICTION_STEPS)
  )
}

/** A close's cause: the user closing this chat, or the host evicting it (quit, idle, teardown). */
export type StructuredAgentSessionCloseCause = Extract<
  StructuredAgentSessionStopCause,
  'user-close' | 'evict'
>

/** Whether the conversation's handle is only a cache now: no child, no wind-down owed, and nothing
 *  queued or waiting on the provider. */
export function structuredAgentSessionConversationClosable(
  session: StructuredAgentSessionHostSession
): boolean {
  return (
    owedProviderChildWindDown(session) === undefined &&
    !session.journal.submissions().some(isQueuedAgentJournalSubmission) &&
    session.journal.pendingSubmissions().length === 0
  )
}

/**
 * Drops the conversation's open fold: a map delete, then its admitted writes drain. The entry
 * leaves the map first, so a lock-free reader sees an open conversation or none — never one that
 * is closing — and one arriving after the delete waits behind this step and reopens. Answers
 * false, closing nothing, when the conversation is still more than a cache.
 */
export async function closeStructuredAgentSessionConversationUnderSerialize(
  context: Pick<StructuredAgentSessionLifetimeContext, 'sessions'> & {
    /** The status row outlives the handle; see `StructuredAgentSessionClientDelivery`. */
    closeStatus: (sessionId: string) => void
  },
  sessionId: string
): Promise<boolean> {
  const session = context.sessions.get(sessionId)
  if (!session || !structuredAgentSessionConversationClosable(session)) {
    return false
  }
  context.sessions.delete(sessionId)
  context.closeStatus(sessionId)
  await session.journal.close()
  return true
}

/** Stops every provider child owned by this host while keeping failed evictions reachable. A
 *  session whose child is already stopped but whose wind-down aborted is still in scope — that is
 *  the retry. */
export async function evictOwnedStructuredAgentSessions(
  context: StructuredAgentSessionLifetimeContext & {
    serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
  },
  retainOnFailure: Set<string>
): Promise<void> {
  const ownedSessionIds = [...context.sessions]
    .filter(([, session]) => owedProviderChildWindDown(session) !== undefined)
    .map(([sessionId]) => sessionId)
  // Retained up front and cleared only once a stop settles: the quit phase is bounded, and a
  // timeout leaves these still running. Closing their journals underneath them is the one outcome
  // the retain set exists to prevent.
  for (const sessionId of ownedSessionIds) {
    retainOnFailure.add(sessionId)
  }
  const failures: unknown[] = []
  await Promise.all(
    ownedSessionIds.map(async (sessionId) => {
      try {
        await context.serialize(sessionId, () =>
          stopStructuredAgentSessionAgentUnderSerialize(context, sessionId, {
            cause: 'evict',
            quit: true
          })
        )
        retainOnFailure.delete(sessionId)
      } catch (error) {
        failures.push(error)
      }
    })
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'structured agent-session child eviction failed')
  }
}
