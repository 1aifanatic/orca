import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  awaitClaudeTurnEnd,
  CLAUDE_STOP_GRACE_MS,
  claudeStoppedTurnEndWait,
  settleClaudeTurnEndWaiters
} from './claude-turn-end-wait'
import type { ClaudeSession } from './claude-structured-session-state'

// Only the open turn is read: the wait derives everything else from it.
function session(currentTurnId: string | null = 'turn-1'): ClaudeSession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait reads only `translator.currentTurnId`, and keys its waiters by the session's identity.
  return { translator: { currentTurnId } } as unknown as ClaudeSession
}

async function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  return settled
}

describe("a Stop's wait for Claude to end the stopped turn", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits out the whole time for a turn Claude never ends', async () => {
    const waiting = awaitClaudeTurnEnd(session(), 'turn-1', CLAUDE_STOP_GRACE_MS)

    expect(await settledWithin(waiting, CLAUDE_STOP_GRACE_MS - 1)).toBe(false)
    expect(await settledWithin(waiting, 1)).toBe(true)
  })

  it('ends as soon as the stopped turn ends', async () => {
    const claude = session()
    const waiting = awaitClaudeTurnEnd(claude, 'turn-1', CLAUDE_STOP_GRACE_MS)
    settleClaudeTurnEndWaiters(claude)

    expect(await settledWithin(waiting, 0)).toBe(true)
  })

  it('holds nothing when the stopped turn already ended or another one is open', async () => {
    expect(await settledWithin(awaitClaudeTurnEnd(session(null), 'turn-1', 1_000), 0)).toBe(true)
    expect(await settledWithin(awaitClaudeTurnEnd(session('turn-2'), 'turn-1', 1_000), 0)).toBe(
      true
    )
  })

  it('waits only what the interrupt left of the grace, and nothing for a session that is gone', async () => {
    const sessions = new Map([['session-1', session()]])
    const wait = claudeStoppedTurnEndWait(sessions)
    const stoppedAt = Date.now()
    await vi.advanceTimersByTimeAsync(CLAUDE_STOP_GRACE_MS - 1_000)
    const waiting = wait('session-1', 'turn-1', stoppedAt)

    expect(await settledWithin(waiting, 999)).toBe(false)
    expect(await settledWithin(waiting, 1)).toBe(true)
    expect(await settledWithin(wait('session-2', 'turn-1', Date.now()), 0)).toBe(true)
  })
})
