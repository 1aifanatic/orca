// The one thing that starts a provider child for a send, the one thing that hands a message to
// it, and the one thing that settles a queued message because of a start, a child or a leftover.
//
// A send is accepted on its own serialized step and returns; this loop does the rest. It exists
// for a session exactly while a message is queued there — accepted, not yet handed over — and no
// child is running a conversation command: a command's turn takes no input, and the commit that
// ends it wakes the loop again. Every step re-reads the journal and the conversation's child
// record to decide, so there is no loop state to disagree with them. Each step is its own serialized task. That is what lets a Stop
// that arrives while a start holds the queue withdraw the queued messages before the handover that
// would have written them. Stop and the conversation's close are the only other writers of a
// queued message: a child's exit only ends the child, and this loop reads why.
//
// A start that fails is recorded on the message it was for, which waits for its next try while the
// messages behind it go on; a timer wakes the loop when that try is due. The timer is a cache: every
// step re-derives what is due from the journal.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  earliestStartRetryAt,
  setStartRetryTimer,
  leftoverRejection,
  nextDeliverableSubmission,
  recordStructuredAgentSessionStartAttemptFailure,
  submissionsHandedToChild,
  type StructuredAgentSessionStartAttemptFailure
} from './structured-agent-session-start-attempt-failure'
import {
  markProviderChildStartFailed,
  markProviderChildStartFailureRecorded
} from './structured-agent-session-provider-child'
import {
  childWhoseStartFailed,
  closeWhatTheUserClosed,
  startThatFailedUnrecorded,
  structuredAgentSessionEndedChildFailure
} from './structured-agent-session-ended-child-failure'
import { handOverSubmission } from './structured-agent-session-turns'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'

export type StructuredAgentSessionDeliveryLoopDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** A start step, tracked from enqueue so quit waits for the child it may produce. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  /** Starts a child for `startedFor`, the queued message at the head, if the session has none. */
  ensureProviderChild: (
    sessionId: string,
    startedFor: string
  ) => Promise<StructuredAgentSessionResumeOutcome>
  /** Ends the session's child, whose start failed, as a host stop; for a caller inside `serialize`. */
  endFailedStart: (sessionId: string) => Promise<void>
  /** The fence the conversation's own writes carry; see `structuredAgentSessionConversationFence`. */
  conversationFence: (sessionId: string) => number
  /** Rejects queued messages as a completed close of the chat does; false when that failed. */
  abandonQueued: (
    sessionId: string,
    which: (submission: AgentJournalSubmission) => boolean
  ) => Promise<boolean>
  /** Who the chat's failure sentences name. */
  failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  onError: (sessionId: string, error: unknown) => void
  record: (sessionId: string) => AgentSessionRecord | null
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  flushStreamedEvents: (sessionId: string) => Promise<void>
  now: () => number
  /** Runs `run` after `delayMs`; answers how to cancel it. */
  setTimer?: (delayMs: number, run: () => void) => () => void
}

type Step = 'continue' | 'stop'

type Prepared =
  | Step
  | (Extract<StructuredAgentSessionResumeOutcome, { ok: false }> & { startedFor: string })
  // `waitingFor`: the message the start was waited on for.
  | { ok: true; awaited: StructuredAgentSessionProviderChildIdentity | null; waitingFor: string }

export class StructuredAgentSessionDeliveryLoop {
  private readonly running = new Set<string>()
  private readonly retryTimers = new Map<string, () => void>()
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionDeliveryLoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Quit: no step after this one starts a child or hands a message over. */
  dispose(): void {
    this.disposed = true
    for (const cancel of this.retryTimers.values()) {
      cancel()
    }
    this.retryTimers.clear()
  }

  /** From inside the session's serialize, after a message was accepted or the conversation
   *  opened. A loop already running re-reads the journal on its next step. */
  wake(sessionId: string): void {
    if (this.disposed || this.running.has(sessionId)) {
      return
    }
    this.running.add(sessionId)
    void this.run(sessionId)
  }

  private async run(sessionId: string): Promise<void> {
    try {
      for (;;) {
        const prepared = await this.deps.trackStart(
          this.deps.serialize(sessionId, () => this.prepare(sessionId))
        )
        if (prepared === 'stop') {
          return
        }
        if (prepared === 'continue') {
          continue
        }
        if (!prepared.ok) {
          const { refusal, diagnostic, startedFor } = prepared
          const cause = { refusal, ...(diagnostic ? { diagnostic } : {}) }
          await this.deps.serialize(sessionId, () =>
            this.fail(sessionId, { generation: null, cause }, [startedFor])
          )
          continue
        }
        // A child published before it proved its start takes no input yet; waited for outside
        // the queue so a Stop can reach it meanwhile.
        const failure = await this.deps.adapter.awaitStarted?.(sessionId)
        const handed = await this.deps.serialize(sessionId, () =>
          this.handOver(sessionId, prepared, failure || null)
        )
        if (handed === 'stop') {
          return
        }
      }
    } catch (error) {
      // The error is Orca's own and goes to the log; the chat says only that Orca failed.
      this.deps.onError(sessionId, error)
      await this.deps
        .serialize(sessionId, async () => {
          const next = this.nextDeliverable(sessionId)
          await this.fail(
            sessionId,
            { generation: null, cause: { hostFault: true } },
            next ? [next.clientMessageId] : []
          )
          return this.stop(sessionId)
        })
        .catch((failure: unknown) => {
          // Rows left queued are rejected by the next open, or by the next loop an accept wakes.
          this.running.delete(sessionId)
          this.deps.onError(sessionId, failure)
        })
    }
  }

  /** Settles what an earlier host process left queued, then makes the session ready. */
  private async prepare(sessionId: string): Promise<Prepared> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    await session.journal.rejectQueuedSubmissions(
      this.deps.conversationFence(sessionId),
      leftoverRejection(
        session.journal,
        this.deps.record(sessionId),
        agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
          surface: 'rejection'
        })
      ),
      // A handle closes only with nothing queued, so one an earlier handle wrote is a leftover.
      (submission) => session.journal.wroteBeforeOpen(submission.acceptedSequence)
    )
    const closed = (which: (submission: AgentJournalSubmission) => boolean) =>
      this.deps.abandonQueued(sessionId, which)
    if (!(await closeWhatTheUserClosed(session, closed))) {
      // Never start an agent for a message the user closed; the next wake re-derives and retries.
      return this.stop(sessionId)
    }
    const next = this.nextDeliverable(sessionId)
    const failedStart = startThatFailedUnrecorded(session, next)
    if (failedStart) {
      return this.fail(sessionId, failedStart.failure, failedStart.waiting, failedStart.ended)
    }
    const failedChild = childWhoseStartFailed(session, next)
    if (failedChild) {
      return failedChild === 'end'
        ? this.deps.endFailedStart(sessionId).then(() => 'continue')
        : this.stop(sessionId)
    }
    // A running command takes no input while its child carries it; its end is a commit, which
    // wakes the loop again. With no child it is a gone generation's, which the start below settles.
    if (!next || (session.child && structuredAgentSessionCommandRunning(session.journal))) {
      return this.stop(sessionId)
    }
    const ready = await this.deps.ensureProviderChild(sessionId, next.clientMessageId)
    if (!ready.ok) {
      return { ...ready, startedFor: next.clientMessageId }
    }
    const child = this.deps.sessions.get(sessionId)?.child
    // The child this run waits on; handover checks it is still the one there.
    return {
      ok: true,
      awaited: child ? { generation: child.generation, fence: child.fence } : null,
      waitingFor: next.clientMessageId
    }
  }

  private async handOver(
    sessionId: string,
    { awaited, waitingFor }: Extract<Prepared, { ok: true }>,
    startFailure: SubmissionRejectionFact | null
  ): Promise<Step> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // Re-derived here, not carried from the start: the child may have ended, or another may have
    // taken its place, since.
    const { child } = session
    const awaitedChild =
      child && awaited && child.generation === awaited.generation && child.fence === awaited.fence
        ? child
        : null
    // The host's `starting` trails the adapter's `started` by one serialized step, so for the child
    // waited on, the adapter's own answer decides whether its start landed.
    if (!awaitedChild || (awaitedChild.phase === 'starting' && startFailure !== null)) {
      // The child waited on is gone, replaced by another, or settled its start without proving it.
      const ended = awaitedChild ? undefined : session.lastEndedChild
      const endedFailure = ended ? structuredAgentSessionEndedChildFailure(ended) : undefined
      // A user's Stop or close is not a failure: the next step starts, or waits on, a child for
      // what is queued, after closing what a close of the chat closed.
      if (endedFailure === null) {
        return 'continue'
      }
      if (awaitedChild) {
        // The adapter ends a start it settled unproven; that end wakes the loop again.
        markProviderChildStartFailed(session, awaitedChild)
      }
      return this.fail(
        sessionId,
        {
          generation: awaited?.generation ?? null,
          cause: endedFailure ??
            // Gone with no end observed: nothing says the provider stopped.
            { failure: startFailure ?? agentSessionFailureFact('startFailed') }
        },
        [waitingFor, ...(awaited ? submissionsHandedToChild(session.journal, awaited.fence) : [])],
        awaitedChild ? undefined : (awaited ?? undefined)
      )
    }
    const next = this.nextDeliverable(sessionId)
    if (!next) {
      return this.stop(sessionId)
    }
    const unstarted = await handOverSubmission(
      {
        sessionId,
        journal: session.journal,
        fence: awaitedChild.fence,
        adapter: this.deps.adapter,
        providerChildPhase: () => this.deps.sessions.get(sessionId)?.child?.phase,
        failureTextContext: this.deps.failureTextContext(sessionId),
        record: () => this.deps.record(sessionId),
        childWork: () => this.deps.readChildWork(sessionId),
        flushStreamedEvents: () => this.deps.flushStreamedEvents(sessionId),
        now: this.deps.now
      },
      next
    )
    if (!unstarted) {
      return 'continue'
    }
    // The child had not proven its start, so it took nothing it was handed, this message included:
    // it is ended, and each goes back in the queue with the start's failure.
    await this.deps.endFailedStart(sessionId)
    return this.fail(
      sessionId,
      { generation: awaitedChild.generation, cause: unstarted },
      submissionsHandedToChild(session.journal, awaitedChild.fence),
      awaitedChild
    )
  }

  /** Records a failed start on the messages it was for; the rest of the queue goes on. */
  private async fail(
    sessionId: string,
    failure: StructuredAgentSessionStartAttemptFailure,
    clientMessageIds: readonly string[],
    ended?: StructuredAgentSessionProviderChildIdentity
  ): Promise<'continue'> {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      if (ended) {
        markProviderChildStartFailureRecorded(session, ended)
      }
      await recordStructuredAgentSessionStartAttemptFailure(
        {
          journal: session.journal,
          fence: this.deps.conversationFence(sessionId),
          record: this.deps.record(sessionId),
          now: this.deps.now
        },
        failure,
        clientMessageIds
      )
    }
    return 'continue'
  }

  private nextDeliverable(sessionId: string): AgentJournalSubmission | undefined {
    const session = this.deps.sessions.get(sessionId)
    return session ? nextDeliverableSubmission(session.journal, this.deps.now()) : undefined
  }

  /** Inside the serialized step that found nothing to do, so an accept after it wakes anew. Books a
   *  wake for the earliest message waiting out a failed start. */
  private stop(sessionId: string): 'stop' {
    this.running.delete(sessionId)
    this.retryTimers.get(sessionId)?.()
    this.retryTimers.delete(sessionId)
    const due = earliestStartRetryAt(this.deps.sessions.get(sessionId)?.journal)
    if (due !== null && !this.disposed) {
      const setTimer = this.deps.setTimer ?? setStartRetryTimer
      const cancel = setTimer(Math.max(0, due - this.deps.now()), () => {
        this.retryTimers.delete(sessionId)
        void this.deps
          .serialize(sessionId, async () => this.wake(sessionId))
          .catch((error: unknown) => this.deps.onError(sessionId, error))
      })
      this.retryTimers.set(sessionId, cancel)
    }
    return 'stop'
  }
}
