import { Writable } from 'node:stream'
import { RelayDispatcher } from './dispatcher'
import { FrameDecoder, MessageType, parseJsonRpcMessage } from './protocol'

type WrittenFrame = { method: string; seq?: number }
type PendingWrite = { frame: WrittenFrame; complete: (error?: Error | null) => void }
export const nextBulkWriteTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve))

export function createBulkWriteHarness() {
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
    fillProducerQueue(id = 'test-pty', limit = Number.POSITIVE_INFINITY): number {
      let admitted = 0
      const params = { id, data: 'p'.repeat(1024) }
      while (admitted < limit && dispatcher.tryNotifyPtyData(params)) {
        admitted++
      }
      return admitted
    },
    async releaseOne(error?: Error): Promise<void> {
      pending.shift()?.complete(error)
      await nextBulkWriteTurn()
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
        await nextBulkWriteTurn()
      }
      throw new Error('Bulk write did not arrive within admitted queue bound')
    },
    async drain(): Promise<void> {
      for (let count = 0; count < 4000; count++) {
        if (!pending.length) {
          await nextBulkWriteTurn()
          if (!pending.length) {
            return
          }
        }
        pending.shift()?.complete()
        await nextBulkWriteTurn()
      }
      throw new Error('Sink did not drain within admitted queue bound')
    },
    dispose(): void {
      dispatcher.dispose()
      sink.destroy()
    }
  }
}
