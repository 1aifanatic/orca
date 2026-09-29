import { describe, expect, it, vi } from 'vitest'
import { createCoalescingKeyedRunner } from './coalescing-keyed-runner'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createCoalescingKeyedRunner', () => {
  it('runs a lone call once and returns its result', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const work = vi.fn(async () => 'done')

    await expect(run('repo', work)).resolves.toBe('done')
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('folds a burst that arrives mid-run into one trailing run that every burst caller shares', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const first = deferred<string>()
    const firstWork = vi.fn(() => first.promise)
    const leading = run('repo', firstWork)
    await vi.waitFor(() => expect(firstWork).toHaveBeenCalledTimes(1))

    const burstWork = Array.from({ length: 5 }, (_, index) =>
      vi.fn(async () => `trailing-${index}`)
    )
    const burst = burstWork.map((work) => run('repo', work))
    expect(burstWork.every((work) => work.mock.calls.length === 0)).toBe(true)

    first.resolve('leading')
    await expect(leading).resolves.toBe('leading')
    // The trailing run uses the latest caller's work, and every burst caller gets its result.
    await expect(Promise.all(burst)).resolves.toEqual(Array(5).fill('trailing-4'))
    expect(burstWork.slice(0, 4).every((work) => work.mock.calls.length === 0)).toBe(true)
    expect(burstWork[4]).toHaveBeenCalledTimes(1)
  })

  it('starts the trailing run even when the run in flight rejects', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const first = deferred<string>()
    const leading = run('repo', () => first.promise)
    const trailing = run('repo', async () => 'after failure')

    first.reject(new Error('boom'))
    await expect(leading).rejects.toThrow('boom')
    await expect(trailing).resolves.toBe('after failure')
  })

  it('does not let a rejected run block the next call', async () => {
    const run = createCoalescingKeyedRunner<string>()

    const failing = async (): Promise<string> => {
      throw new Error('boom')
    }
    await expect(run('repo', failing)).rejects.toThrow('boom')
    await expect(run('repo', async () => 'next')).resolves.toBe('next')
  })

  it('runs different keys concurrently', async () => {
    const run = createCoalescingKeyedRunner<string>()
    const held = deferred<string>()
    const heldResult = run('repo-a', () => held.promise)
    const other = vi.fn(async () => 'other')

    await expect(run('repo-b', other)).resolves.toBe('other')
    expect(other).toHaveBeenCalledTimes(1)
    held.resolve('held')
    await expect(heldResult).resolves.toBe('held')
  })

  it('starts fresh once a key has settled, instead of joining a finished run', async () => {
    const run = createCoalescingKeyedRunner<number>()
    let runs = 0
    const work = async () => ++runs

    await expect(run('repo', work)).resolves.toBe(1)
    await expect(run('repo', work)).resolves.toBe(2)

    const leading = run('repo', work)
    const trailing = run('repo', work)
    await expect(Promise.all([leading, trailing])).resolves.toEqual([3, 4])
    await expect(run('repo', work)).resolves.toBe(5)
  })
})
