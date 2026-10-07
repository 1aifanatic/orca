import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { FrameDecoder, MessageType, parseJsonRpcMessage } from './protocol'

type WrittenFrame = { method: string; seq?: number }
type PendingWrite = { frame: WrittenFrame; complete: (error?: Error | null) => void }
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function createSinkHarness() {
  const frames: WrittenFrame[] = []
  const pending: PendingWrite[] = []
  const sink = new Writable({
    highWaterMark: 64 * 1024,
    write(bytes: Buffer, _encoding, complete) {
      let frame: WrittenFrame | undefined
      const decoder = new FrameDecoder((decoded) => {
        if (decoded.type !== MessageType.Regular) {
          return
        }
        const message = parseJsonRpcMessage(decoded.payload)
        if (!('method' in message)) {
          return
        }
        frame = {
          method: message.method,
          ...(typeof message.params?.seq === 'number' ? { seq: message.params.seq } : {})
        }
      })
      decoder.feed(bytes)
      if (!frame) {
        throw new Error('Expected one notification frame')
      }
      frames.push(frame)
      pending.push({ frame, complete })
    }
  })
  sink.on('error', () => {})
  const dispatcher = new RelayDispatcher(
    (bytes, settled) =>
      sink.write(bytes, (error) => settled(error ? { ok: false, error } : { ok: true })),
    {
      supportsWriteCallback: true,
      writableLength: () => sink.writableLength,
      writableHighWaterMark: () => sink.writableHighWaterMark,
      waitWriteDrain: (callback) => {
        sink.once('drain', callback)
        return () => sink.off('drain', callback)
      }
    }
  )
  return {
    dispatcher,
    frames,
    pending,
    fillProducerQueue(): number {
      let admitted = 0
      const params = { id: 'test-pty', data: 'p'.repeat(1024) }
      while (dispatcher.tryNotifyPtyData(params)) {
        admitted++
      }
      return admitted
    },
    async releaseOne(error?: Error): Promise<void> {
      pending.shift()?.complete(error)
      await nextTurn()
    },
    async reachBulk(method: string): Promise<void> {
      for (let count = 0; count < 3000; count++) {
        if (pending[0]?.frame.method === method) {
          return
        }
        if (!pending.length) {
          throw new Error('No pending write before bulk admission')
        }
        pending.shift()?.complete()
        await nextTurn()
      }
      throw new Error('Bulk write did not arrive within admitted queue bound')
    },
    async drain(): Promise<void> {
      for (let count = 0; count < 4000; count++) {
        if (!pending.length) {
          await nextTurn()
          if (!pending.length) {
            return
          }
        }
        pending.shift()?.complete()
        await nextTurn()
      }
      throw new Error('Sink did not drain within admitted queue bound')
    },
    dispose(): void {
      dispatcher.dispose()
      sink.destroy()
    }
  }
}

describe('bulk admission and sink settlement', () => {
  it('sends a capacity-blocked frame once and advances the client chain after its callback', async () => {
    const harness = createSinkHarness()
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
      await nextTurn()
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
    const harness = createSinkHarness()
    try {
      const error = new Error('owned sink failure')
      const result = harness.dispatcher.notifyBulk('git.responseChunk', { streamId: 1, seq: 0 })
      const assertion = expect(result).rejects.toBe(error)
      await nextTurn()
      await harness.releaseOne(error)
      await assertion
    } finally {
      harness.dispose()
    }
  })

  it('settles disposal while an admitted bulk frame awaits its callback', async () => {
    const harness = createSinkHarness()
    try {
      let settled = false
      const result = harness.dispatcher
        .notifyBulk('git.responseChunk', { streamId: 1, seq: 0 })
        .then(() => {
          settled = true
        })
      await nextTurn()
      expect(settled).toBe(false)
      harness.dispatcher.dispose()
      await result
      expect(settled).toBe(true)
    } finally {
      harness.dispose()
    }
  })

  it('keeps fixed bulk behind retained producers and sends it once', async () => {
    const harness = createSinkHarness()
    try {
      const producerFrames = harness.fillProducerQueue()
      let settled = false
      const result = harness.dispatcher
        .notifyBulk('fs.streamChunk', { streamId: 1, data: 'fixed' })
        .then(() => {
          settled = true
        })
      await nextTurn()
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
