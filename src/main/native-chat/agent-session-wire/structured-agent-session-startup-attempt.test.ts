import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS,
  StructuredAgentSessionStartupAttempts,
  mintStructuredAgentSessionStartupAttempt,
  type StructuredAgentSessionExpiredStartup
} from './structured-agent-session-startup-attempt'

const SESSION = 'session-alpha'
const CHILD = { generation: 'generation-1', fence: 3 }

let expired: StructuredAgentSessionExpiredStartup[]
let attempts: StructuredAgentSessionStartupAttempts

function mint() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mint reads only the lease fence, location, account home, options and updatedAt this literal sets.
  const record = {
    lease: { runtimeFence: CHILD.fence },
    location: { executionHostId: 'local', workspaceId: 'workspace-1' },
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    updatedAt: 1
  } as unknown as AgentSessionRecord
  return mintStructuredAgentSessionStartupAttempt({
    record,
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    },
    spawnToken: 'spawn-1',
    now: Date.now()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  expired = []
  attempts = new StructuredAgentSessionStartupAttempts({
    now: () => Date.now(),
    expire: (startup) => expired.push(startup)
  })
})

afterEach(() => {
  attempts.dispose()
  vi.useRealTimers()
})

describe('a startup attempt deadline', () => {
  it('counts from the mint and fires once, naming the acquire still in flight', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt)

    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS - 1)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)

    expect(expired).toEqual([{ sessionId: SESSION, attemptId: attempt.attemptId, child: null }])
    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS)
    expect(expired).toHaveLength(1)
  })

  it('names the starting child an acquire published', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt)
    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'starting' })

    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS)

    expect(expired).toEqual([{ sessionId: SESSION, attemptId: attempt.attemptId, child: CHILD }])
  })

  it('ends with the start its child proved, and ignores a stale child’s proof', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt)
    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'starting' })

    attempts.ready(SESSION, { ...CHILD, generation: 'generation-0' })
    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS / 2)
    attempts.ready(SESSION, CHILD)
    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS)

    expect(expired).toEqual([])
  })

  it('ends with an acquire that answered ready, or an attach that failed', () => {
    const ready = mint()
    attempts.track(SESSION, ready)
    attempts.published(SESSION, ready.attemptId, { ...CHILD, phase: 'ready' })
    const failed = mint()
    attempts.track('session-beta', failed)
    attempts.abandon('session-beta', failed.attemptId)

    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS)

    expect(expired).toEqual([])
  })

  it('expires a child published after its deadline passed, once it is published', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt)
    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS)

    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'starting' })

    expect(expired.map((startup) => startup.child)).toEqual([null, CHILD])
  })

  it('is replaced by the next attempt, and stops at quit', () => {
    const first = mint()
    attempts.track(SESSION, first)
    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS / 2)
    const second = mint()
    attempts.track(SESSION, second)
    attempts.abandon(SESSION, first.attemptId)

    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS / 2)
    expect(expired).toEqual([])
    attempts.dispose()
    vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_STARTUP_DEADLINE_MS)

    expect(expired).toEqual([])
  })
})
