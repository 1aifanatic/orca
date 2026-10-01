import { describe, expect, it } from 'vitest'
import {
  WORKTREE_DELETE_CONCURRENCY,
  _worktreeDeleteLimitSnapshotForTests,
  runUnderWorktreeDeleteLimit
} from './worktree-delete-limit'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('runUnderWorktreeDeleteLimit', () => {
  it('runs at most the limit at once and starts queued deletes in arrival order', async () => {
    const limit = WORKTREE_DELETE_CONCURRENCY
    const gates = Array.from({ length: limit + 2 }, deferred)
    const started: number[] = []
    const runs = gates.map((gate, index) =>
      runUnderWorktreeDeleteLimit(async () => {
        started.push(index)
        await gate.promise
      })
    )
    await Promise.resolve()

    const firstWave = Array.from({ length: limit }, (_, index) => index)
    expect(started).toEqual(firstWave)
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: limit, waiting: 2 })

    gates[1]?.resolve()
    await runs[1]
    await Promise.resolve()
    expect(started).toEqual([...firstWave, limit])

    for (const gate of gates) {
      gate.resolve()
    }
    await Promise.all(runs)
    expect(started).toEqual([...firstWave, limit, limit + 1])
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 0, waiting: 0 })
  })

  it('frees the slot when a delete fails', async () => {
    await expect(
      runUnderWorktreeDeleteLimit(async () => {
        throw new Error('locked')
      })
    ).rejects.toThrow('locked')
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 0, waiting: 0 })
  })
})
