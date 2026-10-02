import { EventEmitter } from 'node:events'
import type { WorkerRequestTransport } from '../lazy-worker-thread-host'
import { handleForeignSqliteReaderRequest } from './foreign-sqlite-reader-dispatch'
import type { ForeignSqliteReaderRequest } from './foreign-sqlite-reader-protocol'

// Test-only: vitest has no built worker entry, so caller suites that read real
// fixture databases run the real dispatch in-process through the real client.

class InProcessForeignSqliteReaderWorker extends EventEmitter implements WorkerRequestTransport {
  private terminated = false

  postMessage(request: ForeignSqliteReaderRequest): void {
    // A structured clone, as a real worker would receive it.
    const cloned = structuredClone(request)
    queueMicrotask(() => {
      if (!this.terminated) {
        this.emit('message', structuredClone(handleForeignSqliteReaderRequest(cloned)))
      }
    })
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }
}

export function createInProcessForeignSqliteReaderWorker(): WorkerRequestTransport {
  return new InProcessForeignSqliteReaderWorker()
}
