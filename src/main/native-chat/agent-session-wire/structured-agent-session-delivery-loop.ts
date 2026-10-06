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
// A start that fails is recorded on the one message it was for, and the messages behind it each
// get their own start. Every write names a message fixed when its pass chose it, never the queue's
// head read again after a failure.

import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionStartFailureCause } from './structured-agent-session-failure-text'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  oldestQueuedSubmission,
  rejectStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-settlement'
import {
  childWhoseStartFailed,
  startThatFailedWhileQueued,
  structuredAgentSessionEndedChildFailure
} from './structured-agent-session-ended-child-failure'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { handOverSubmission } from './structured-agent-session-turns'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'

export type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'

type Step = 'continue' | 'stop'

type Prepared =
  | Step
  | (Extract<StructuredAgentSessionResumeOutcome, { ok: false }> & { startedFor: string })
  // `waitingFor`: the message the start was waited on for.
  | { ok: true; awaited: StructuredAgentSessionProviderChildIdentity | null; waitingFor: string }

/** The message one pass is attempting, set before each await that could fail for it, so a throw
 *  still knows its target. Dies with the pass. */
type Attempt = { clientMessageId?: string }

export class StructuredAgentSessionDeliveryLoop {
  private readonly running = new Set<string>()
  /** The child each session's current pass waits on to prove its start; gone with the pass. */
  private readonly waitingOn = new Map<string, StructuredAgentSessionProviderChildIdentity>()
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionDeliveryLoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Whether a pass waits on this child's start: its exit then fails that pass's message. */
  awaits(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): boolean {
    const awaited = this.waitingOn.get(sessionId)
    return awaited !== undefined && sameProviderChild(awaited, child)
  }

  /** Quit: no step after this one starts a child or hands a message over. */
  dispose(): void {
    this.disposed = true
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
    for (;;) {
      const attempt: Attempt = {}
      let step: Step
      try {
        step = await this.attempt(sessionId, attempt)
      } catch (error) {
        step = await this.failAttempt(sessionId, attempt, error)
      }
      if (step === 'stop') {
        return
      }
    }
  }

  /** One message's pass: a start for it, then its handover. A failed start fails only that
   *  message; the next pass takes the one behind it. */
  private async attempt(sessionId: string, attempt: Attempt): Promise<Step> {
    const prepared = await this.deps.trackStart(
      this.deps.serialize(sessionId, () => this.prepare(sessionId, attempt))
    )
    if (prepared === 'stop' || prepared === 'continue') {
      return prepared
    }
    if (!prepared.ok) {
      return this.deps.serialize(sessionId, () =>
        this.rejectStartFailure(
          sessionId,
          this.refusedStart(sessionId, prepared),
          prepared.startedFor
        )
      )
    }
    if (prepared.awaited) {
      this.waitingOn.set(sessionId, prepared.awaited)
    }
    try {
      // A child published before it proved its start takes no input yet; waited for outside
      // the queue so a Stop can reach it meanwhile.
      const failure = await this.deps.adapter.awaitStarted?.(sessionId)
      return await this.deps.serialize(sessionId, () =>
        this.handOver(sessionId, prepared, failure || null, attempt)
      )
    } finally {
      this.waitingOn.delete(sessionId)
    }
  }

  /** The error is Orca's own and goes to the log; the chat says only that Orca failed, on the
   *  message this pass attempted and never on another. */
  private async failAttempt(sessionId: string, attempt: Attempt, error: unknown): Promise<Step> {
    this.deps.logger.warn('delivering a queued message failed', {
      scope: 'delivery-loop',
      sessionId,
      error
    })
    const { clientMessageId } = attempt
    try {
      return await this.deps.serialize(sessionId, async () =>
        clientMessageId === undefined
          ? this.stop(sessionId)
          : this.rejectStartFailure(sessionId, { hostFault: true }, clientMessageId)
      )
    } catch (failure) {
      // Left queued, it is taken by the next wake, or rejected as a leftover by the next open.
      this.running.delete(sessionId)
      this.deps.logger.warn('recording a failed delivery failed', {
        scope: 'delivery-loop-fail',
        sessionId,
        error: failure
      })
      return 'stop'
    }
  }

  /** Settles what an earlier host process left queued, then makes the session ready. */
  private async prepare(sessionId: string, attempt: Attempt): Promise<Prepared> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    await session.journal.rejectQueuedSubmissions(
      this.deps.conversationFence(sessionId),
      agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), { surface: 'rejection' }),
      // A handle closes only with nothing queued, so one an earlier handle wrote is a leftover.
      (submission) => session.journal.wroteBeforeOpen(submission.acceptedSequence)
    )
    if (!(await this.closeWhatTheUserClosed(sessionId, session))) {
      // Never start an agent for a message the user closed; the next wake re-derives and retries.
      return this.stop(sessionId)
    }
    const oldest = oldestQueuedSubmission(session.journal)
    // A running command takes no input while its child carries it; its end is a commit, which
    // wakes the loop again. With no child it is a gone generation's, which the start below settles.
    if (!oldest || (session.child && structuredAgentSessionCommandRunning(session.journal))) {
      return this.stop(sessionId)
    }
    const failedStart = startThatFailedWhileQueued(session)
    if (failedStart) {
      attempt.clientMessageId = failedStart.clientMessageId
      return this.rejectStartFailure(sessionId, failedStart.cause, failedStart.clientMessageId)
    }
    if (childWhoseStartFailed(session)) {
      // The next message gets a fresh start rather than this child's failure.
      await this.endFailedStart(sessionId)
    }
    attempt.clientMessageId = oldest.clientMessageId
    const ready = await this.deps.ensureProviderChild(sessionId, oldest.clientMessageId)
    if (!ready.ok && ready.refusal.details?.reason === 'previousExitUnverifiable') {
      // Failed in the step that was refused: a message accepted, or an exit proven, after it must
      // not be failed for a verdict that no longer holds.
      return this.rejectStartFailure(
        sessionId,
        this.refusedStart(sessionId, ready),
        oldest.clientMessageId
      )
    }
    if (!ready.ok) {
      return { ...ready, startedFor: oldest.clientMessageId }
    }
    const child = this.deps.sessions.get(sessionId)?.child
    // The child this run waits on; handover checks it is still the one there.
    return {
      ok: true,
      awaited: child ? { generation: child.generation, fence: child.fence } : null,
      waitingFor: oldest.clientMessageId
    }
  }

  private async handOver(
    sessionId: string,
    { awaited, waitingFor }: Extract<Prepared, { ok: true }>,
    startFailure: SubmissionRejectionFact | null,
    attempt: Attempt
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
      // A child still here is ended by the next message's step (`childWhoseStartFailed`), after any
      // exit of its own already queued: the message's failure never waits on that cleanup.
      return this.rejectStartFailure(
        sessionId,
        endedFailure ??
          // Gone with no end observed: nothing says the provider stopped.
          { failure: startFailure ?? agentSessionFailureFact('startFailed') },
        waitingFor
      )
    }
    const next = oldestQueuedSubmission(session.journal)
    if (!next) {
      return this.stop(sessionId)
    }
    attempt.clientMessageId = next.clientMessageId
    await handOverSubmission(
      {
        sessionId,
        journal: session.journal,
        fence: awaitedChild.fence,
        adapter: this.deps.adapter,
        agents: this.deps.agents,
        providerChildPhase: () => this.deps.sessions.get(sessionId)?.child?.phase,
        failureTextContext: this.deps.failureTextContext(sessionId),
        record: () => this.deps.record(sessionId),
        childWork: () => this.deps.readChildWork(sessionId),
        now: this.deps.now
      },
      next
    )
    return 'continue'
  }

  /** A start the session refused, as the failure the message it was for is rejected with. */
  private refusedStart(
    sessionId: string,
    { refusal, diagnostic }: Extract<StructuredAgentSessionResumeOutcome, { ok: false }>
  ): StructuredAgentSessionStartFailureCause {
    // A conversation no agent ever ran, such as a cleared chat's, failed to start, not restart.
    const newSession = this.deps.record(sessionId)?.providerHandleChain.length === 0
    return {
      refusal,
      ...(diagnostic ? { diagnostic } : {}),
      ...(newSession ? { newSession: true as const } : {})
    }
  }

  /** Fails only the message the start was for; the next pass takes the one behind it. */
  private async rejectStartFailure(
    sessionId: string,
    cause: StructuredAgentSessionStartFailureCause,
    clientMessageId: string
  ): Promise<'continue'> {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      await rejectStructuredAgentSessionStartFailure(
        {
          journal: session.journal,
          fence: this.deps.conversationFence(sessionId),
          record: this.deps.record(sessionId)
        },
        cause,
        clientMessageId
      )
    }
    return 'continue'
  }

  /** Ends a child whose start failed, once its message is settled. Best effort: a stop that could
   *  not prove the exit leaves the child closing, and the next start is refused for that
   *  (`previousExitUnverifiable`), as after any such stop. */
  private async endFailedStart(sessionId: string): Promise<void> {
    try {
      await this.deps.endFailedStart(sessionId)
    } catch (error) {
      this.deps.logger.warn('ending a failed start failed', {
        scope: 'delivery-loop-end-failed-start',
        sessionId,
        error
      })
    }
  }

  /** A close of this chat that stopped its child and then did not complete still closed what was
   *  queued before it, so no child starts for those. Ordered, not latched: a later send goes on.
   *  False when those could not be closed. */
  private async closeWhatTheUserClosed(
    sessionId: string,
    session: StructuredAgentSessionHostSession
  ): Promise<boolean> {
    const ended = session.lastEndedChild
    if (session.child || ended?.cause !== 'user-close') {
      return true
    }
    const { epoch } = session.journal.cursor()
    return this.deps.abandonQueued(
      sessionId,
      (submission) =>
        ended.endedAt.epoch === epoch &&
        submission.acceptedSequence !== undefined &&
        submission.acceptedSequence <= ended.endedAt.sequence
    )
  }

  /** Inside the serialized step that found nothing to do, so an accept after it wakes anew. */
  private stop(sessionId: string): 'stop' {
    this.running.delete(sessionId)
    return 'stop'
  }
}
