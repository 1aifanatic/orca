import { describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

function pendingChainCount(queue: StructuredAgentSessionTaskQueue): number {
  return (queue as unknown as { chains: Map<string, Promise<void>> }).chains.size
}

function privateMapSize(
  queue: StructuredAgentSessionTaskQueue,
  field: 'pending' | 'queuedListeners'
) {
  return (queue as unknown as Record<typeof field, Map<string, unknown>>)[field].size
}

describe('StructuredAgentSessionTaskQueue', () => {
  it('deletes a successful settled tail', async () => {
    const queue = new StructuredAgentSessionTaskQueue()

    await expect(queue.serialize('session-1', async () => 'done')).resolves.toBe('done')
    await Promise.resolve()

    expect(pendingChainCount(queue)).toBe(0)
  })

  it('deletes a rejected settled tail without poisoning the next task', async () => {
    const queue = new StructuredAgentSessionTaskQueue()

    await expect(
      queue.serialize('session-1', async () => {
        throw new Error('failed')
      })
    ).rejects.toThrow('failed')
    await expect(queue.serialize('session-1', async () => 'recovered')).resolves.toBe('recovered')
    await Promise.resolve()

    expect(pendingChainCount(queue)).toBe(0)
  })

  it('does not let an earlier tail cleanup delete an overlapping replacement', async () => {
    const queue = new StructuredAgentSessionTaskQueue()
    const firstGate = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    const order: string[] = []
    const first = queue.serialize('session-1', async () => {
      order.push('first-start')
      await firstGate.promise
      order.push('first-end')
    })
    const second = queue.serialize('session-1', async () => {
      order.push('second-start')
      await secondGate.promise
      order.push('second-end')
    })

    firstGate.resolve()
    await first
    expect(pendingChainCount(queue)).toBe(1)
    await vi.waitFor(() => expect(order).toEqual(['first-start', 'first-end', 'second-start']))

    secondGate.resolve()
    await second
    await Promise.resolve()
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
    expect(pendingChainCount(queue)).toBe(0)
  })

  describe('who waits for a chat', () => {
    it('counts each call behind the running one until it settles, however it settles', async () => {
      const queue = new StructuredAgentSessionTaskQueue()
      const running = Promise.withResolvers<void>()
      const behind: boolean[] = []
      const first = queue.serialize('session-1', async () => {
        behind.push(queue.hasQueuedBehind('session-1'))
        await running.promise
      })
      const outcomes = [
        queue.serialize('session-1', async () => {
          behind.push(queue.hasQueuedBehind('session-1'))
          throw new Error('async reject')
        }),
        queue.serialize('session-1', () => {
          behind.push(queue.hasQueuedBehind('session-1'))
          throw new Error('sync throw')
        }),
        queue.serialize('session-1', async () => {
          behind.push(queue.hasQueuedBehind('session-1'))
        })
      ]
      expect(queue.hasQueuedBehind('session-1')).toBe(true)
      expect(queue.hasQueuedBehind('session-2')).toBe(false)

      running.resolve()
      await first
      await Promise.allSettled(outcomes)
      await Promise.resolve()

      // Each saw calls behind it but the last.
      expect(behind).toEqual([true, true, true, false])
      expect(queue.hasQueuedBehind('session-1')).toBe(false)
      expect(privateMapSize(queue, 'pending')).toBe(0)
    })

    it('counts a call the running one queues on its own chat', async () => {
      const queue = new StructuredAgentSessionTaskQueue()
      let nested: Promise<void> | null = null
      let seen = false

      await queue.serialize('session-1', async () => {
        nested = queue.serialize('session-1', async () => undefined)
        seen = queue.hasQueuedBehind('session-1')
      })
      await nested
      await Promise.resolve()

      expect(seen).toBe(true)
      expect(privateMapSize(queue, 'pending')).toBe(0)
    })

    it('tells a holder when a call is queued, and leaves no listener behind', async () => {
      const queue = new StructuredAgentSessionTaskQueue()
      const done = new AbortController()
      for (let i = 0; i < 100; i += 1) {
        const stop = new AbortController()
        const next = queue.nextQueued('session-1', stop.signal)
        stop.abort()
        await next
      }
      expect(privateMapSize(queue, 'queuedListeners')).toBe(0)

      const queued = queue.nextQueued('session-1', done.signal)
      void queue.serialize('session-1', async () => undefined)

      await expect(queued).resolves.toBeUndefined()
      expect(privateMapSize(queue, 'queuedListeners')).toBe(0)
      // A signal already aborted resolves at once.
      await expect(queue.nextQueued('session-1', AbortSignal.abort())).resolves.toBeUndefined()
      expect(privateMapSize(queue, 'queuedListeners')).toBe(0)
    })
  })
})
