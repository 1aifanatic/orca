// The background copy's share of the main thread: no second gives its tasks more than the budget
// plus the one task that crossed it, and quit ends a wait at once.

import { describe, expect, it, vi } from 'vitest'
import {
  PER_CHAT_FILE_COPY_SHARE_BUDGET_MS,
  PER_CHAT_FILE_COPY_SHARE_WINDOW_MS,
  StructuredAgentSessionPerChatFileCopyPace
} from './structured-agent-session-per-chat-file-copy-pace'

/** A pace on a clock the test moves; a wait moves the clock by what it waits. */
function pacedClock() {
  const clock = { now: 0 }
  const waits: number[] = []
  const pace = new StructuredAgentSessionPerChatFileCopyPace(
    () => clock.now,
    async (ms) => {
      waits.push(ms)
      clock.now += ms
    }
  )
  /** Runs tasks of these costs, a yield after each; answers each window's busy time. */
  const run = async (costs: number[]) => {
    const busy = new Map<number, number>()
    pace.begin()
    for (const cost of costs) {
      const window = Math.floor(clock.now / PER_CHAT_FILE_COPY_SHARE_WINDOW_MS)
      busy.set(window, (busy.get(window) ?? 0) + cost)
      clock.now += cost
      await pace.yieldTask()
    }
    return [...busy.values()]
  }
  return { clock, waits, pace, run }
}

describe('the copy’s share of each second (C3)', () => {
  it('waits for the next second once its tasks have taken the budget', async () => {
    const { waits, run } = pacedClock()

    const busy = await run(Array.from({ length: 40 }, () => 40))

    expect(waits.length).toBeGreaterThan(0)
    for (const ms of busy) {
      expect(ms).toBeLessThanOrEqual(PER_CHAT_FILE_COPY_SHARE_BUDGET_MS + 40)
    }
  })

  it('counts a task that stalls, so a long one ends the second’s share', async () => {
    const { waits, clock, run } = pacedClock()

    await run([200])

    expect(waits).toEqual([PER_CHAT_FILE_COPY_SHARE_WINDOW_MS - 200])
    expect(clock.now).toBe(PER_CHAT_FILE_COPY_SHARE_WINDOW_MS)
  })

  it('takes no wait under the budget', async () => {
    const { waits, run } = pacedClock()

    await run([10, 10, 10])

    expect(waits).toEqual([])
  })

  it('ends a wait at quit, and waits no more after it', async () => {
    const pace = new StructuredAgentSessionPerChatFileCopyPace(() => 0, undefined, 0)
    const waiting = pace.yieldTask()
    const settled = vi.fn()
    void waiting.then(settled)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()

    pace.stop()
    await waiting
    await expect(pace.yieldTask()).resolves.toBeUndefined()
  })
})
