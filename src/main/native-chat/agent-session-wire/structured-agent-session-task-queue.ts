import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'

/** Whether anyone is waiting for a chat's lock, for a holder that may give way to them. */
export type StructuredAgentSessionChatWaiters = {
  /** Whether a call on this chat is queued behind the one running. */
  hasQueuedBehind: (sessionId: string) => boolean
  /** Resolves when the next call on this chat is queued, or once `signal` aborts. */
  nextQueued: (sessionId: string, signal: AbortSignal) => Promise<void>
}

export class StructuredAgentSessionTaskQueue implements StructuredAgentSessionChatWaiters {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly attaching = new Set<Promise<unknown>>()
  /** Calls on each chat not yet settled: the one running, and those queued behind it. */
  private readonly pending = new Map<string, number>()
  private readonly queuedListeners = new Map<string, Set<() => void>>()

  serialize = <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + 1)
    for (const listener of this.queuedListeners.get(sessionId) ?? []) {
      listener()
    }
    const run = runKeyedSerializedOperation(this.chains, sessionId, task)
    const settle = (): void => {
      const left = (this.pending.get(sessionId) ?? 1) - 1
      if (left > 0) {
        this.pending.set(sessionId, left)
      } else {
        this.pending.delete(sessionId)
      }
    }
    void run.then(settle, settle)
    return run
  }

  hasQueuedBehind = (sessionId: string): boolean => (this.pending.get(sessionId) ?? 0) > 1

  nextQueued = (sessionId: string, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const listeners = this.queuedListeners.get(sessionId) ?? new Set()
      this.queuedListeners.set(sessionId, listeners)
      const done = (): void => {
        listeners.delete(done)
        if (listeners.size === 0) {
          this.queuedListeners.delete(sessionId)
        }
        signal.removeEventListener('abort', done)
        resolve()
      }
      if (signal.aborted) {
        done()
        return
      }
      listeners.add(done)
      signal.addEventListener('abort', done)
    })

  trackAttach<T>(operation: Promise<T>): Promise<T> {
    this.attaching.add(operation)
    void operation.then(
      () => this.attaching.delete(operation),
      () => this.attaching.delete(operation)
    )
    return operation
  }

  async drainAttaches(): Promise<void> {
    while (this.attaching.size > 0) {
      await Promise.allSettled(this.attaching)
    }
  }
}
