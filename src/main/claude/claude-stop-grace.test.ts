import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armClaudeStopGrace,
  awaitClaudeStopGrace,
  CLAUDE_STOP_GRACE_MS,
  settleClaudeStopGrace
} from './claude-stop-grace'
import type { ClaudeSession } from './claude-structured-session-state'

// Only its identity is read: the grace is keyed by the session.
function session(): ClaudeSession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the grace reads no field of the session, only its identity as a WeakMap key.
  return {} as ClaudeSession
}

async function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  return settled
}

describe("a Stop's grace before Claude's child ends", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits out the whole grace for a turn Claude never ends, then lets the close go on', async () => {
    const claude = session()
    armClaudeStopGrace(claude)
    const waiting = awaitClaudeStopGrace(claude)

    expect(await settledWithin(waiting, CLAUDE_STOP_GRACE_MS - 1)).toBe(false)
    expect(await settledWithin(waiting, 1)).toBe(true)
  })

  it('ends as soon as the stopped turn ends', async () => {
    const claude = session()
    armClaudeStopGrace(claude)
    const waiting = awaitClaudeStopGrace(claude)
    settleClaudeStopGrace(claude)

    expect(await settledWithin(waiting, 0)).toBe(true)
  })

  it('counts a turn that ended before the close asked', async () => {
    const claude = session()
    armClaudeStopGrace(claude)
    settleClaudeStopGrace(claude)

    expect(await settledWithin(awaitClaudeStopGrace(claude), 0)).toBe(true)
  })

  it('holds nothing for an interrupt Claude did not take, or with no Stop armed', async () => {
    const refused = session()
    armClaudeStopGrace(refused)()

    expect(await settledWithin(awaitClaudeStopGrace(refused), 0)).toBe(true)
    expect(await settledWithin(awaitClaudeStopGrace(session()), 0)).toBe(true)
  })
})
