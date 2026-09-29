import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const workers = vi.hoisted(() => [] as { finish: (error?: Error) => void }[])

vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super()
      workers.push({
        finish: (error) => {
          if (error) {
            this.emit('error', error)
          }
          this.emit('exit', error ? 1 : 0)
        }
      })
    }
  }
}))

import { removeTreeOffThreadPool } from './tree-removal-worker'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('removeTreeOffThreadPool', () => {
  const options = { recursive: true, force: true }

  beforeEach(() => {
    workers.length = 0
  })

  // A history-tombstone drain starts dozens of removals at once; each worker is a whole isolate.
  it('runs at most four background workers at a time and frees a slot on failure', async () => {
    const outcomes = Array.from({ length: 10 }, (_, index) =>
      removeTreeOffThreadPool(`/tree-${index}`, options, 'background').then(
        () => 'removed',
        (error: Error) => error.message
      )
    )
    await flush()
    expect(workers).toHaveLength(4)

    workers[0].finish(new Error('EBUSY'))
    await flush()
    expect(workers).toHaveLength(5)

    for (let started = 1; started < workers.length; started++) {
      workers[started].finish()
      await flush()
      expect(workers.length).toBeLessThanOrEqual(started + 5)
    }

    expect(workers).toHaveLength(10)
    expect(await Promise.all(outcomes)).toEqual(['EBUSY', ...Array(9).fill('removed')])
  })

  // A multi-minute worktree-trash delete must not hold a user's awaited folder delete.
  it('starts an interactive removal while the background lane is saturated', async () => {
    const background = Array.from({ length: 6 }, (_, index) =>
      removeTreeOffThreadPool(`/trash-${index}`, options, 'background')
    )
    await flush()
    expect(workers).toHaveLength(4)

    const interactive = removeTreeOffThreadPool('/folder', options, 'interactive')
    await flush()
    expect(workers).toHaveLength(5)
    workers[4].finish()
    await expect(interactive).resolves.toBeUndefined()

    for (let index = 0; index < workers.length; index++) {
      if (index !== 4) {
        workers[index].finish()
        await flush()
      }
    }
    await Promise.all(background)
    expect(workers).toHaveLength(7)
  })
})
