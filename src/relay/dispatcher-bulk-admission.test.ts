import { describe, expect, it } from 'vitest'
import { createBulkWriteHarness, nextBulkWriteTurn } from './dispatcher-bulk-write-test-harness'

describe('bulk admission and sink settlement', () => {
  it('sends a capacity-blocked frame once and advances the client chain after its callback', async () => {
    const harness = createBulkWriteHarness()
    try {
      expect(harness.fillProducerQueue()).toBeGreaterThan(0)
      let firstSettled = false
      const first = harness.dispatcher
        .notifyBulk('git.responseChunk', { streamId: 1, seq: 0, data: 'g'.repeat(40 * 1024) })
        .then(() => {
          firstSettled = true
        })
      const second = harness.dispatcher.notifyBulk('git.responseChunk', {
        streamId: 1,
        seq: 1,
        data: 'following'
      })
      await nextBulkWriteTurn()
      await harness.reachBulk('git.responseChunk')
      expect(firstSettled).toBe(false)
      expect(harness.frames.some((frame) => frame.seq === 1)).toBe(false)
      await harness.releaseOne()
      await harness.drain()
      await Promise.all([first, second])
      expect(harness.frames.filter((frame) => frame.method === 'git.responseChunk')).toEqual([
        { method: 'git.responseChunk', seq: 0 },
        { method: 'git.responseChunk', seq: 1 }
      ])
    } finally {
      harness.dispose()
    }
  })

  it('preserves the admitted frame’s sink failure', async () => {
    const harness = createBulkWriteHarness()
    try {
      const error = new Error('owned sink failure')
      const result = harness.dispatcher.notifyBulk('git.responseChunk', { streamId: 1, seq: 0 })
      const assertion = expect(result).rejects.toBe(error)
      await nextBulkWriteTurn()
      await harness.releaseOne(error)
      await assertion
    } finally {
      harness.dispose()
    }
  })

  it('settles disposal while an admitted bulk frame awaits its callback', async () => {
    const harness = createBulkWriteHarness()
    try {
      let settled = false
      const result = harness.dispatcher
        .notifyBulk('git.responseChunk', { streamId: 1, seq: 0 })
        .then(() => {
          settled = true
        })
      await nextBulkWriteTurn()
      expect(settled).toBe(false)
      harness.dispatcher.dispose()
      await result
      expect(settled).toBe(true)
    } finally {
      harness.dispose()
    }
  })

  it('keeps fixed bulk behind retained producers and sends it once', async () => {
    const harness = createBulkWriteHarness()
    try {
      const producerFrames = harness.fillProducerQueue()
      let settled = false
      const result = harness.dispatcher
        .notifyBulk('fs.streamChunk', { streamId: 1, data: 'fixed' })
        .then(() => {
          settled = true
        })
      await nextBulkWriteTurn()
      expect(harness.frames.some((frame) => frame.method === 'fs.streamChunk')).toBe(false)
      await harness.reachBulk('fs.streamChunk')
      expect(harness.frames.filter((frame) => frame.method === 'pty.data')).toHaveLength(
        producerFrames
      )
      expect(settled).toBe(false)
      await harness.releaseOne()
      await result
      expect(harness.frames.filter((frame) => frame.method === 'fs.streamChunk')).toEqual([
        { method: 'fs.streamChunk' }
      ])
    } finally {
      harness.dispose()
    }
  })
})
