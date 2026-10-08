import { KeyedOperationQueue } from './keyed-operation-queue'
import { resolvePtyInputHoldMs, type PtyInputHold } from './pty-input-hold'

export type PtyInputBinding = { key: string; isCurrent: () => boolean }

export function ptyInputTransactionKey(ptyId: string, incarnation?: string): string {
  return `${ptyId}\u0000${incarnation ?? ''}`
}

export class PtyInputPreemptedError extends Error {
  constructor(readonly bytesHandedToTransport: boolean) {
    super(bytesHandedToTransport ? 'partial_write' : 'request_aborted')
  }
}

export class PtyInputAbandonedError extends Error {
  constructor(readonly bytesHandedToTransport: boolean) {
    super(bytesHandedToTransport ? 'partial_write' : 'request_timeout')
  }
}

export type PtyInputTransactionOptions = {
  signal?: AbortSignal
  deadlineAt?: number
  interrupt?: boolean
  hold?: PtyInputHold | (() => PtyInputHold)
}

export class PtyInputTransaction {
  private handedOff = false
  private interrupted = false
  private abandoned: PtyInputAbandonedError | undefined
  private readonly abandonment = new AbortController()

  constructor(
    private readonly binding: PtyInputBinding,
    private readonly signal: AbortSignal | undefined,
    private readonly holdDeadlineAt: number,
    private readonly requestDeadlineAt?: number
  ) {}

  get abandonmentSignal(): AbortSignal {
    return this.abandonment.signal
  }

  assertWithinHold(): void {
    if (Date.now() >= this.holdDeadlineAt) {
      this.abandon()
    }
    if (this.abandoned) {
      throw this.abandoned
    }
  }

  abandon(): PtyInputAbandonedError {
    if (!this.abandoned) {
      this.abandoned = new PtyInputAbandonedError(this.handedOff)
      this.abandonment.abort()
    }
    return this.abandoned
  }

  run<T>(operation: (transaction: PtyInputTransaction) => T | Promise<T>): T | Promise<T> {
    this.beforeWrite()
    const result = operation(this)
    if (!(result instanceof Promise)) {
      this.assertWithinHold()
      return result
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(
        () => {
          settled = true
          // Fence before releasing ownership; an in-flight provider write keeps its own settlement.
          reject(this.abandon())
        },
        Math.max(0, this.holdDeadlineAt - Date.now())
      )
      result.then(
        (value) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          try {
            this.assertWithinHold()
            resolve(value)
          } catch (error) {
            reject(error)
          }
        },
        (error) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          try {
            this.assertWithinHold()
            reject(error)
          } catch (expired) {
            reject(expired)
          }
        }
      )
    })
  }

  preempt(): void {
    this.interrupted = true
  }

  beforeWrite(): void {
    this.assertWithinHold()
    if (!this.binding.isCurrent()) {
      throw new Error('terminal_not_writable')
    }
    if (this.interrupted) {
      throw new PtyInputPreemptedError(this.handedOff)
    }
    if (!this.handedOff && this.signal?.aborted) {
      throw new Error('request_aborted')
    }
    if (
      !this.handedOff &&
      this.requestDeadlineAt !== undefined &&
      Date.now() >= this.requestDeadlineAt
    ) {
      throw new Error('request_timeout')
    }
  }

  handoff(): void {
    this.beforeWrite()
    this.handedOff = true
  }
}

export class PtyInputTransactions {
  private readonly queue = new KeyedOperationQueue()

  get size(): number {
    return this.queue.size
  }

  run<T>(
    binding: PtyInputBinding,
    operation: (transaction: PtyInputTransaction) => T | Promise<T>,
    options: PtyInputTransactionOptions = {}
  ): T | Promise<T> {
    let transaction: PtyInputTransaction | undefined
    return this.queue.run(
      binding.key,
      () => {
        const acquiredAt = Date.now()
        const hold = typeof options.hold === 'function' ? options.hold() : options.hold
        transaction = new PtyInputTransaction(
          binding,
          options.signal,
          acquiredAt + resolvePtyInputHoldMs(hold),
          options.deadlineAt
        )
        return transaction.run(operation)
      },
      {
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        priority: options.interrupt,
        preempt: () => transaction?.preempt()
      }
    )
  }
}

export const ptyInputTransactions = new PtyInputTransactions()
