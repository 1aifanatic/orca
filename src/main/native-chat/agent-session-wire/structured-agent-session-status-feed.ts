// The host's answer to "what is every structured session doing", fanned out to session lists.
//
// A client used to learn whether a turn was running by replaying the journal through its own
// reducer, which tied the answer to whichever surface happened to hold a reader open: hide the
// chat and the sidebar froze on the last thing it had heard. The host always has the journal, so
// it projects the status once per journal publication and sends only the changes.
//
// The last projection is kept after the session's provider child is evicted: an idle session is
// still idle without a process, and a renderer that reloads must not lose every settled row until
// each chat is reopened. At startup, a settled chat's row is seeded from the state stored beside its
// journal (journal-session-state.ts) without opening it; a chat that owes work is settled by its
// open, which publishes as any open does.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import {
  projectStructuredAgentSessionStatusState,
  type StructuredAgentSessionStatusProjection
} from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import {
  structuredAgentSessionStatusSummary,
  structuredAgentSessionSummariesEqual
} from './structured-agent-session-status-summary'
import {
  StructuredAgentSessionStatusOwnership,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-ownership'

export type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionStatusSubscriber = {
  id: string
  emit: (event: AgentSessionStatusEvent) => void
}

/** All the feed reads of a chat's journal. */
type StatusFeedJournal = Pick<AgentSessionJournal, 'isReadOnly' | 'lastActivityAt' | 'statusState'>

type StatusFeedSession = {
  journal: StatusFeedJournal
  params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
  child?: Pick<StructuredAgentSessionProviderChild, 'phase' | 'generation' | 'fence'> | null
}

export type StructuredAgentSessionStatusFeedDeps = {
  sessions: ReadonlyMap<string, StatusFeedSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  now: () => number
  /** Every projection change, whether or not anyone is subscribed. `replay` marks a re-projection
   *  of state the host already knew (restore, an arriving subscriber) rather than a journal edge. */
  onStatusChanged?: (summary: AgentSessionStatusSummary, options: { replay: boolean }) => void
  /** Resolved on every call: the host builds this feed in a field initializer, before its own
   *  deps are assigned. */
  statusSink?: () => StructuredAgentSessionStatusSink | undefined
  /** Live provider-owned background tasks for the summary, so session lists can
   *  render subagent children. Optional: a provider without the hook projects none. */
  readBackgroundTasks?: (sessionId: string) => AgentSessionBackgroundTaskState | null | undefined
  /** The session's agent proved a start: its row's phase became `ready`. */
  onAgentStarted?: (sessionId: string) => void
}

/** Wire the host's own deps into a feed; keeps the host at one call site.
 *  `deps` is a thunk because the host builds the feed in a field initializer,
 *  before its constructor parameters are assigned. */
export function createStructuredAgentSessionHostStatusFeed(args: {
  sessions: StructuredAgentSessionStatusFeedDeps['sessions']
  now: () => number
  deps: () => {
    store: { getRecord: (sessionId: string) => AgentSessionRecord | null }
    adapter: {
      backgroundTaskState?: (
        sessionId: string
      ) => AgentSessionBackgroundTaskState | null | undefined
    }
    onSessionStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged']
    statusSink?: StructuredAgentSessionStatusSink
  }
  onAgentStarted?: (sessionId: string) => void
}): StructuredAgentSessionStatusFeed {
  return new StructuredAgentSessionStatusFeed({
    sessions: args.sessions,
    getRecord: (sessionId) => args.deps().store.getRecord(sessionId),
    now: args.now,
    onStatusChanged: (summary, options) => args.deps().onSessionStatusChanged?.(summary, options),
    readBackgroundTasks: (sessionId) => args.deps().adapter.backgroundTaskState?.(sessionId),
    // Resolved per call for the same reason the other deps are: the host builds this feed in a
    // field initializer, before its constructor parameters are assigned.
    statusSink: () => args.deps().statusSink,
    ...(args.onAgentStarted ? { onAgentStarted: args.onAgentStarted } : {})
  })
}

export class StructuredAgentSessionStatusFeed {
  private readonly ownership = new StructuredAgentSessionStatusOwnership(() =>
    this.deps.statusSink?.()
  )
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()
  private readonly published = new Map<string, AgentSessionStatusSummary>()

  constructor(private readonly deps: StructuredAgentSessionStatusFeedDeps) {}

  /** Opens with every session this host has projected, live ones re-read, then only changes. */
  subscribe(subscriber: StructuredAgentSessionStatusSubscriber): () => void {
    // Re-project before registering: a change found here has to reach the subscribers that
    // already read the old value, and the arriving one carries it in its snapshot instead.
    for (const [sessionId] of this.deps.sessions) {
      this.publish(sessionId, undefined, { replay: true })
    }
    this.subscribers.set(subscriber.id, subscriber)
    this.emit(subscriber, { type: 'snapshot', sessions: [...this.published.values()] })
    return () => this.unsubscribe(subscriber.id)
  }

  /** The host stopped holding the session: ownership leaves the retained projection, and the
   *  row leaves the sink. `published` keeps the projection for reload history. */
  close(sessionId: string): void {
    this.revokeLive(sessionId)
    this.forget(sessionId)
  }

  /** The sink lists what is running; a forgotten session must not be in it. */
  forget(sessionId: string): void {
    try {
      this.ownership.forget(sessionId)
    } catch (error) {
      console.warn('[structured-session-status] status sink forget failed', error)
    }
  }

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) {
      return
    }
    this.subscribers.delete(id)
    try {
      subscriber.emit({ type: 'end' })
    } catch {
      // The transport is already gone; teardown must remain idempotent.
    }
  }

  /** Revoke live execution authority while retaining the last projection for reload history. */
  revokeLive(sessionId: string): void {
    const previous = this.published.get(sessionId)
    if (!previous) {
      return
    }
    const {
      hostExecutionOwned: _hostExecutionOwned,
      hostExecutionPhase: _hostExecutionPhase,
      hostExecutionChild: _hostExecutionChild,
      ...retained
    } = previous
    this.published.set(sessionId, retained)
    this.sink(retained)
    this.broadcast({
      type: 'status',
      session: retained
    })
  }

  /** The projection behind the session's row and the latest request it read, cached per commit,
   *  so the completion feed follows the same request without snapshotting the journal again. */
  statusState(
    sessionId: string,
    journal?: StatusFeedJournal
  ): StructuredAgentSessionStatusState | null {
    const session = this.deps.sessions.get(sessionId)
    const source = journal ?? session?.journal
    return source ? this.projectionFor(source, this.deps.getRecord(sessionId)) : null
  }

  /** Re-projects one session after its journal changed; equal projections are not re-sent. */
  publish(sessionId: string, journal?: StatusFeedJournal, options?: { replay?: boolean }): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    this.publishSummary(
      this.summaryFor(sessionId, session, journal ?? session.journal),
      session.params.location,
      { replay: options?.replay === true }
    )
  }

  private publishSummary(
    summary: AgentSessionStatusSummary,
    location: AgentSessionRecord['location'],
    options: { replay: boolean }
  ): void {
    const { sessionId } = summary
    const previous = this.published.get(sessionId)
    if (previous && structuredAgentSessionSummariesEqual(previous, summary)) {
      if (!this.ownership.matchesLocation(sessionId, location)) {
        this.sink(summary, location)
      }
      return
    }
    this.published.set(sessionId, summary)
    this.sink(summary, location)
    this.broadcast({ type: 'status', session: summary })
    if (summary.hostExecutionPhase === 'ready' && previous?.hostExecutionPhase !== 'ready') {
      this.deps.onAgentStarted?.(sessionId)
    }
    try {
      this.deps.onStatusChanged?.(summary, options)
    } catch (error) {
      // An observer must never cost the subscribers their status event.
      console.warn('[structured-session-status] status observer failed', error)
    }
  }

  private summaryFor(
    sessionId: string,
    session: StatusFeedSession,
    journal: StatusFeedJournal
  ): AgentSessionStatusSummary {
    const record = this.deps.getRecord(sessionId)
    return structuredAgentSessionStatusSummary({
      sessionId,
      params: session.params,
      record,
      child: session.child,
      projected: this.projectionFor(journal, record).summary,
      backgroundTasks: this.deps.readBackgroundTasks?.(sessionId),
      lastActivityAt: journal.lastActivityAt(),
      now: this.deps.now
    })
  }

  /**
   * A chat's row from the state stored beside its journal, for one this host has not opened: the
   * same builder an open's publish uses, so the open later finds it equal and sends nothing. A
   * replay, as a restore's publish is.
   */
  seed(
    record: AgentSessionRecord,
    stored: { projected: StructuredAgentSessionStatusProjection; lastActivityAt: number }
  ): void {
    const { sessionId } = record
    if (this.deps.sessions.has(sessionId)) {
      return
    }
    const params = { location: record.location, provider: record.provider }
    this.publishSummary(
      structuredAgentSessionStatusSummary({
        sessionId,
        params,
        record,
        projected: stored.projected,
        backgroundTasks: this.deps.readBackgroundTasks?.(sessionId),
        lastActivityAt: stored.lastActivityAt,
        now: this.deps.now
      }),
      params.location,
      { replay: true }
    )
  }

  /** Child-work evidence for a session this feed publishes; a failing sink costs nothing else. */
  publishChildWork(sessionId: string, evidence: AgentChildWorkEvidence[]): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    try {
      this.ownership.publishChildWork(sessionId, evidence, session.params.provider)
    } catch (error) {
      console.warn('[structured-session-status] child work publish failed', error)
    }
  }

  private projectionFor(
    journal: StatusFeedJournal,
    record: AgentSessionRecord | null
  ): StructuredAgentSessionStatusState {
    // The conversation's fence, which a child's end moves: its unanswered sends stop counting.
    const fence = record?.lease.runtimeFence
    // An unreadable journal projects as "no turn": the chat itself shows the reset. Otherwise
    // the journal's own projection, once per commit and fence, which its stored state reads too.
    return journal.isReadOnly
      ? projectStructuredAgentSessionStatusState([], [], fence)
      : journal.statusState(fence)
  }

  /** A failing sink must never cost the subscribers their status event. */
  private sink(
    summary: AgentSessionStatusSummary,
    location?: AgentSessionRecord['location']
  ): void {
    try {
      this.ownership.publish(summary, location)
    } catch (error) {
      console.warn('[structured-session-status] status sink publish failed', error)
    }
  }

  private broadcast(event: AgentSessionStatusEvent): void {
    // A Map skips entries deleted mid-iteration, so a failing subscriber can drop itself here.
    for (const subscriber of this.subscribers.values()) {
      this.emit(subscriber, event)
    }
  }

  /** A dead transport must not poison every later publication. */
  private emit(subscriber: StructuredAgentSessionStatusSubscriber, event: AgentSessionStatusEvent) {
    try {
      subscriber.emit(event)
    } catch {
      this.subscribers.delete(subscriber.id)
    }
  }
}
