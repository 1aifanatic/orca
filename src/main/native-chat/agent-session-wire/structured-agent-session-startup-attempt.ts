// One start of a conversation's provider child, minted by the host before any adapter acquires.
//
// Whatever a start means as policy belongs to the host and is the same for every agent: which
// conversation and lease it is for, what cancels it, when it gives up, and when its child may take
// input. An adapter only runs its protocol inside the attempt it is handed.
//
// The deadline counts from the mint and nothing renews it: a start that has not proved itself by
// then is not coming. Expiry re-derives what to end from the host's own state, so a timer that
// outlives its attempt ends nothing.

import { randomUUID } from 'node:crypto'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'

export const STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS = 60_000

export type StructuredAgentSessionStartupAttempt = {
  /** The host's generation for this start; never reused, even when the lease fence is. */
  readonly attemptId: string
  readonly identity: AgentSessionJournalIdentity
  readonly fence: number
  readonly spawnToken: string
  /** Where and as whom the record pins the start; an adapter never re-resolves either. */
  readonly launch: Pick<AgentSessionRecord, 'location' | 'accountHome' | 'launchDirectory'>
  /** The saved options the start launches with, as intent; never a catalog guess. */
  readonly options?: Readonly<Record<string, string>>
  /** The record write `options` was read from: a pick after it is newer intent to reconcile. */
  readonly optionsAsOf: number
  /** Provider events may begin before acquisition returns. */
  readonly events?: StructuredAgentSessionEventSink
  /** Background work this start's child reports, scoped to the attempt. Unset until the host routes
   *  child work by attempt; adapters report through their registration until then. */
  readonly childWork?: (evidence: AgentChildWorkEvidence[]) => void
  /** Aborted by a close, a Stop admitted now, quit, or the deadline: the adapter stops what it
   *  started and the acquire fails. */
  readonly signal?: AbortSignal
  /** Host clock. */
  readonly deadlineAt: number
}

export function mintStructuredAgentSessionStartupAttempt(input: {
  record: AgentSessionRecord
  identity: AgentSessionJournalIdentity
  spawnToken: string
  events?: StructuredAgentSessionEventSink
  signal?: AbortSignal
  now: number
  deadlineMs?: number
}): StructuredAgentSessionStartupAttempt {
  const { record } = input
  return {
    attemptId: randomUUID(),
    identity: input.identity,
    fence: record.lease.runtimeFence,
    spawnToken: input.spawnToken,
    launch: {
      location: record.location,
      accountHome: record.accountHome,
      ...(record.launchDirectory === undefined ? {} : { launchDirectory: record.launchDirectory })
    },
    ...(record.options ? { options: record.options } : {}),
    optionsAsOf: record.updatedAt,
    ...(input.events ? { events: input.events } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    deadlineAt: input.now + (input.deadlineMs ?? STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS)
  }
}

/** The deadline's own reason, so an expired start is told from a close, Stop or quit. */
export class StructuredAgentSessionStartupExpiredError extends Error {
  constructor() {
    super('the agent did not finish starting before its deadline')
    this.name = 'StructuredAgentSessionStartupExpiredError'
  }
}

export function isStructuredAgentSessionStartupExpired(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'StructuredAgentSessionStartupExpiredError'
}

/** Where an expired attempt stood: still inside its acquire, or published as a starting child. */
export type StructuredAgentSessionExpiredStartup = {
  sessionId: string
  attemptId: string
  /** Null while the acquire has not returned. */
  child: StructuredAgentSessionProviderChildIdentity | null
}

type Tracked = {
  attempt: StructuredAgentSessionStartupAttempt
  child: StructuredAgentSessionProviderChildIdentity | null
  timer: ReturnType<typeof setTimeout> | null
  expired: boolean
}

/** Each session's open attempt and its deadline. A session starts one child at a time, so a new
 *  attempt replaces any older one. */
export class StructuredAgentSessionStartupAttempts {
  private readonly open = new Map<string, Tracked>()
  private disposed = false

  constructor(
    private readonly deps: {
      now: () => number
      /** Runs outside the session's queue: an acquire may hold it for the whole handshake. */
      expire: (expired: StructuredAgentSessionExpiredStartup) => void
    }
  ) {}

  track(sessionId: string, attempt: StructuredAgentSessionStartupAttempt): void {
    this.end(sessionId)
    const tracked: Tracked = { attempt, child: null, timer: null, expired: false }
    this.open.set(sessionId, tracked)
    if (this.disposed) {
      return
    }
    tracked.timer = setTimeout(
      () => this.expire(sessionId, tracked),
      Math.max(0, attempt.deadlineAt - this.deps.now())
    )
    // A start's deadline must never be the reason a process stays alive at quit.
    tracked.timer.unref?.()
  }

  /** The acquire returned: a `starting` child stays on the deadline until it proves its start, and
   *  one published after its deadline passed is expired now. */
  published(
    sessionId: string,
    attemptId: string,
    child: StructuredAgentSessionProviderChildIdentity & { phase: 'starting' | 'ready' }
  ): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.attempt.attemptId !== attemptId) {
      return
    }
    if (child.phase === 'ready') {
      this.end(sessionId)
      return
    }
    tracked.child = { generation: child.generation, fence: child.fence }
    if (tracked.expired) {
      this.expire(sessionId, tracked)
    }
  }

  /** The child proved its start: its attempt is over. A stale child's proof ends nothing. */
  ready(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.child?.generation === child.generation && tracked.child.fence === child.fence) {
      this.end(sessionId)
    }
  }

  /** The attempt failed, or its attach did: nothing it started is left to time out. */
  abandon(sessionId: string, attemptId: string): void {
    if (this.open.get(sessionId)?.attempt.attemptId === attemptId) {
      this.end(sessionId)
    }
  }

  /** Quit: no deadline fires after this. */
  dispose(): void {
    this.disposed = true
    for (const tracked of this.open.values()) {
      if (tracked.timer) {
        clearTimeout(tracked.timer)
      }
    }
    this.open.clear()
  }

  private expire(sessionId: string, tracked: Tracked): void {
    if (this.open.get(sessionId) !== tracked || this.disposed) {
      return
    }
    tracked.expired = true
    this.deps.expire({ sessionId, attemptId: tracked.attempt.attemptId, child: tracked.child })
  }

  private end(sessionId: string): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.timer) {
      clearTimeout(tracked.timer)
    }
    this.open.delete(sessionId)
  }
}
