type Waiter<T> = { resolve: (value: T) => void; reject: (error: unknown) => void }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * Model work that many readers wait on, each under its own deadline. Why not `work.then` per
 * reader: on a hung mount the work never settles, so every reader that gave up would stay attached
 * to it. Here the work carries one reaction, and a reader that stops waiting leaves nothing behind.
 */
export class SharedDerivationWork<T> {
  private readonly waiters = new Set<Waiter<T>>()
  private outcome: Outcome<T> | null = null

  constructor(readonly promise: Promise<T>) {
    promise.then(
      (value) => this.settle({ ok: true, value }),
      (error: unknown) => this.settle({ ok: false, error })
    )
  }

  private settle(outcome: Outcome<T>): void {
    this.outcome = outcome
    for (const waiter of this.waiters) {
      if (outcome.ok) {
        waiter.resolve(outcome.value)
      } else {
        waiter.reject(outcome.error)
      }
    }
  }

  /** Readers still waiting; a reader that timed out or was aborted is not one. */
  get waiterCount(): number {
    return this.waiters.size
  }

  wait(waitMs: number, onTimeout: () => Error, signal?: AbortSignal): Promise<T> {
    const settled = this.outcome
    if (settled) {
      return settled.ok ? Promise.resolve(settled.value) : Promise.reject(settled.error)
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    return new Promise<T>((resolve, reject) => {
      const leave = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.delete(waiter)
      }
      const waiter: Waiter<T> = {
        resolve: (value) => {
          leave()
          resolve(value)
        },
        reject: (error) => {
          leave()
          reject(error)
        }
      }
      const timer = setTimeout(() => waiter.reject(onTimeout()), waitMs)
      const onAbort = (): void => waiter.reject(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.add(waiter)
    })
  }
}
