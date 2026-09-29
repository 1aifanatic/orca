import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

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
  // A history-tombstone drain starts dozens of removals at once; each worker is a whole isolate.
  it('runs at most four removal workers at a time and frees a slot on failure', async () => {
    const outcomes = Array.from({ length: 10 }, (_, index) =>
      removeTreeOffThreadPool(`/tree-${index}`, { recursive: true, force: true }).then(
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
})
