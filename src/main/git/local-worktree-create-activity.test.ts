import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetLocalWorktreeCreateActivityForTests,
  holdLocalWorktreeCreate,
  isLocalWorktreeCreateInFlight,
  runWithLocalWorktreeCreateHold,
  whenLocalWorktreeCreatesSettle
} from './local-worktree-create-activity'

afterEach(() => {
  vi.useRealTimers()
  _resetLocalWorktreeCreateActivityForTests()
})

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  return settled
}

describe('local worktree create activity', () => {
  it('resolves at once when no create is in flight', async () => {
    expect(await isSettled(whenLocalWorktreeCreatesSettle())).toBe(true)
  })

  it('waits until the last overlapping create settles', async () => {
    const first = holdLocalWorktreeCreate()
    const second = holdLocalWorktreeCreate()
    const idle = whenLocalWorktreeCreatesSettle()

    first()
    expect(await isSettled(idle)).toBe(false)
    second()
    expect(await isSettled(idle)).toBe(true)
    expect(isLocalWorktreeCreateInFlight()).toBe(false)
  })

  it('treats a repeated release as one release', async () => {
    const first = holdLocalWorktreeCreate()
    const second = holdLocalWorktreeCreate()
    first()
    first()
    expect(isLocalWorktreeCreateInFlight()).toBe(true)
    second()
    expect(isLocalWorktreeCreateInFlight()).toBe(false)
  })

  it('gives up waiting at the deadline so a stuck create cannot starve background work', async () => {
    vi.useFakeTimers()
    holdLocalWorktreeCreate()
    const idle = whenLocalWorktreeCreatesSettle(1_000)

    await vi.advanceTimersByTimeAsync(999)
    expect(await isSettled(idle)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await isSettled(idle)).toBe(true)
    expect(isLocalWorktreeCreateInFlight()).toBe(true)
  })

  it('releases the hold when the create throws', async () => {
    await expect(
      runWithLocalWorktreeCreateHold(async () => {
        expect(isLocalWorktreeCreateInFlight()).toBe(true)
        throw new Error('create failed')
      })
    ).rejects.toThrow('create failed')
    expect(isLocalWorktreeCreateInFlight()).toBe(false)
  })
})
