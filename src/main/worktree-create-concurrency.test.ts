import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetWorktreeCreateConcurrencyForTests,
  beginWorktreeCreate,
  withWorktreeCreateInFlight
} from './worktree-create-concurrency'

describe('worktree create concurrency', () => {
  afterEach(() => {
    _resetWorktreeCreateConcurrencyForTests()
  })

  it('reports zero for a create that ran alone', () => {
    expect(beginWorktreeCreate().end()).toBe(0)
  })

  it('reports the most other creates seen at once, including ones that started later', () => {
    const first = beginWorktreeCreate()
    const second = beginWorktreeCreate()
    const third = beginWorktreeCreate()
    expect(second.end()).toBe(2)
    expect(third.end()).toBe(2)
    // Peak, not count at the end: `first` once overlapped two others.
    expect(first.end()).toBe(2)
  })

  it('stops counting a create once it ends, and ending twice is harmless', () => {
    const first = beginWorktreeCreate()
    first.end()
    first.end()
    expect(beginWorktreeCreate().end()).toBe(0)
  })

  it('counts a wrapped create while it runs and releases it on failure', async () => {
    const observer = beginWorktreeCreate()
    await withWorktreeCreateInFlight(async () => {
      throw new Error('create failed')
    }).catch(() => undefined)
    expect(observer.end()).toBe(1)
    expect(beginWorktreeCreate().end()).toBe(0)
  })
})
