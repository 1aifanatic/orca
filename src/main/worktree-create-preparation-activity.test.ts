import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreparationActivity } from './worktree-create-preparation-activity'
import {
  _resetWorktreeCreateConcurrencyForTests,
  beginWorktreeCreate
} from './worktree-create-concurrency'

let now = 0

beforeEach(() => {
  now = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  _resetWorktreeCreateConcurrencyForTests()
  vi.restoreAllMocks()
})

describe('createPreparationActivity', () => {
  it('reports the origin, including a re-arm the prefetch then asked for', () => {
    expect(createPreparationActivity('explicit').origin()).toBe('prefetch')
    expect(createPreparationActivity('automatic').origin()).toBe('rearm')
    const asked = createPreparationActivity('automatic')
    asked.requestedByPrefetch()
    expect(asked.origin()).toBe('rearm_then_prefetch')
  })

  it('extends a build with a tip refresh queued before it finished', async () => {
    const activity = createPreparationActivity('explicit')
    const build = Promise.withResolvers<void>()
    activity.track(build.promise)
    const refresh = Promise.withResolvers<void>()
    const chained = build.promise.then(() => refresh.promise)
    activity.track(chained)
    const observer = beginWorktreeCreate()

    now = 3_000
    build.resolve()
    await build.promise
    now = 5_000
    refresh.resolve()
    await chained

    expect(activity.timesAt(9_000)).toEqual({ buildMs: 4_000, idleMs: 4_000 })
    // One piece of work throughout, not two.
    expect(observer.end().preparations).toBe(1)
  })

  it('times a refresh queued after the build finished from its own start, as new work', async () => {
    const activity = createPreparationActivity('explicit')
    const build = Promise.resolve()
    activity.track(build)
    now = 2_000
    await build
    const observer = beginWorktreeCreate()

    now = 10_000
    const refresh = Promise.withResolvers<void>()
    activity.track(refresh.promise)
    now = 12_500
    refresh.resolve()
    await refresh.promise

    expect(activity.timesAt(13_000)).toEqual({ buildMs: 2_500, idleMs: 500 })
    expect(observer.end().preparations).toBe(1)
  })

  it('reports no idle time when the claim came before the work finished', async () => {
    const activity = createPreparationActivity('automatic')
    const build = Promise.withResolvers<void>()
    activity.track(build.promise)
    now = 4_000
    build.resolve()
    await build.promise
    expect(activity.timesAt(2_000)).toEqual({ buildMs: 3_000, idleMs: 0 })
  })
})
