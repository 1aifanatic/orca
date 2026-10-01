// The background copy's share of the main thread: each of its tasks ends by yielding here, and a
// task that takes more than the copy's share so far waits until the share catches up (a token
// bucket refilled at the share, holding at most a small burst). So any second gives the copy at
// most the share, the burst and the one task that crossed it, however a chat's copy is split into
// batches. Quit ends any wait at once: the copy then stops at its next batch, as without one.

import { performance } from 'node:perf_hooks'
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises'

/** The copy's share of the main thread's wall time, waits on disk included. */
export const PER_CHAT_FILE_COPY_SHARE = 0.15
/** Main-thread time the copy may take at once after it has been idle. */
export const PER_CHAT_FILE_COPY_BURST_MS = 50

export class StructuredAgentSessionPerChatFileCopyPace {
  private tokens = PER_CHAT_FILE_COPY_BURST_MS
  private refilledAt: number
  private taskStart: number
  private readonly stopping = new AbortController()

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) =>
      sleep(ms, undefined, { signal }).catch(() => undefined)
  ) {
    this.refilledAt = clock()
    this.taskStart = this.refilledAt
  }

  /** Quit: no task waits any more. */
  stop(): void {
    this.stopping.abort()
  }

  /** A task of the copy begins: after a wait between runs, for one. */
  begin(): void {
    this.taskStart = this.clock()
  }

  /** Ends the copy's current task: on to the next macrotask, or, when the task took more than the
   *  copy's share so far, after a wait that brings the share back. */
  yieldTask = async (): Promise<void> => {
    const now = this.clock()
    // Refilled while idle before the task, up to the burst; the task refills as it spends.
    this.tokens = Math.min(
      PER_CHAT_FILE_COPY_BURST_MS,
      this.tokens + (this.taskStart - this.refilledAt) * PER_CHAT_FILE_COPY_SHARE
    )
    this.tokens -= (now - this.taskStart) * (1 - PER_CHAT_FILE_COPY_SHARE)
    this.refilledAt = now
    if (this.tokens < 0 && !this.stopping.signal.aborted) {
      await this.wait(-this.tokens / PER_CHAT_FILE_COPY_SHARE, this.stopping.signal)
      this.tokens = 0
      this.refilledAt = this.clock()
    } else {
      await yieldToEventLoop()
    }
    this.taskStart = this.clock()
  }
}
