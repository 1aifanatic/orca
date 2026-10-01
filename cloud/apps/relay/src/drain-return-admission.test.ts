import { describe, expect, it } from 'vitest'
import {
  DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS,
  RelayDrainReturnAdmission,
  type DrainReturnDeferral,
  type DrainReturnGrant
} from './drain-return-admission.js'

type Timer = { at: number; callback: () => void; cancelled: boolean }

function harness(overrides: { maxQueued?: number; maxRetryAfterSeconds?: number } = {}) {
  let now = 0
  const timers: Timer[] = []
  const lane = new RelayDrainReturnAdmission({
    maxConcurrent: 1,
    maxQueued: overrides.maxQueued ?? 0,
    waitMs: 3_000,
    maxRetryAfterSeconds: overrides.maxRetryAfterSeconds ?? 300,
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  return {
    lane,
    advance: (ms: number) => {
      now += ms
      for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) {
        timer.cancelled = true
        timer.callback()
      }
    }
  }
}

function admitted(result: DrainReturnGrant | DrainReturnDeferral): DrainReturnGrant {
  if (result.kind !== 'admitted') throw new Error(`expected admission, got ${result.reason}`)
  return result
}

function deferred(result: DrainReturnGrant | DrainReturnDeferral): DrainReturnDeferral {
  if (result.kind !== 'deferred') throw new Error('expected a deferral')
  return result
}

const host = (index: number): string => `host${String(index).padStart(12, '0')}`

describe('drain-return admission', () => {
  it('admits up to its concurrency and defers the rest with a paced Retry-After', async () => {
    const { lane } = harness()
    admitted(await lane.acquire(host(0)))

    const retries = []
    for (let index = 1; index <= 5; index++) {
      const deferral = deferred(await lane.acquire(host(index)))
      expect(deferral.reason).toBe('queue-full')
      retries.push(deferral.retryAfterSeconds)
    }

    // 860 ms per slot before any measurement: one host per slot, in order.
    expect(retries).toEqual([2, 3, 4, 5, 6])
  })

  it('gives the same answers to the same arrivals', async () => {
    const run = async (): Promise<number[]> => {
      const { lane, advance } = harness({ maxQueued: 2 })
      const answers: number[] = []
      const settled: Promise<void>[] = []
      for (let index = 0; index < 40; index++) {
        settled.push(
          lane.acquire(host(index)).then((result) => {
            if (result.kind === 'deferred') answers.push(result.retryAfterSeconds)
          })
        )
        await Promise.resolve()
        advance(100)
      }
      advance(10_000)
      await Promise.all(settled.slice(1))
      return answers
    }

    const first = await run()
    expect(first).toHaveLength(39)
    expect(await run()).toEqual(first)
    expect(Math.min(...first)).toBeGreaterThanOrEqual(DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS)
  })

  it('never asks a host to wait longer than the configured ceiling', async () => {
    const { lane } = harness({ maxRetryAfterSeconds: 10 })
    admitted(await lane.acquire(host(0)))

    const retries = []
    for (let index = 1; index <= 50; index++) {
      retries.push(deferred(await lane.acquire(host(index))).retryAfterSeconds)
    }

    expect(Math.max(...retries)).toBe(10)
  })

  it('shortens the pacing once the measured service time is short', async () => {
    const { lane, advance } = harness()
    for (let index = 0; index < 30; index++) {
      const grant = admitted(await lane.acquire(host(index)))
      advance(50)
      grant.lease.release()
      advance(2_000)
    }
    admitted(await lane.acquire(host(100)))

    const retries = []
    for (let index = 101; index <= 120; index++) {
      retries.push(deferred(await lane.acquire(host(index))).retryAfterSeconds)
    }

    // ~50 ms per re-placement: twenty deferrals span about one second, where the
    // 860 ms starting estimate would have spread them over seventeen.
    expect(Math.max(...retries)).toBe(3)
  })

  it('defers a host that retries before its interval with the same paced answer', async () => {
    const { lane } = harness()
    admitted(await lane.acquire(host(0))).lease.release()

    const repeat = deferred(await lane.acquire(host(0)))

    expect(repeat.reason).toBe('host-rate-limited')
    expect(repeat.retryAfterSeconds).toBeGreaterThanOrEqual(DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS)
  })
})
