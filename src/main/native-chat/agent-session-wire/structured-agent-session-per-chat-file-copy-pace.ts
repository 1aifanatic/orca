// The background copy's share of the main thread: each of its tasks ends by yielding here, and once
// its tasks have taken the budget of the current second, the next one waits for the next second.
// So no second gives the copy more than the budget plus the one task that crossed it, however a
// chat's copy is split into batches. Quit ends any wait at once: the copy then stops at its next
// batch, as it does without one.

import { performance } from 'node:perf_hooks'
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises'

export const PER_CHAT_FILE_COPY_SHARE_WINDOW_MS = 1_000
/** Main-thread time the copy's tasks may take in each second, wall time, waits included. */
export const PER_CHAT_FILE_COPY_SHARE_BUDGET_MS = 150

export class StructuredAgentSessionPerChatFileCopyPace {
  private windowStart: number
  private used = 0
  private taskStart: number
  private readonly stopping = new AbortController()

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) =>
      sleep(ms, undefined, { signal }).catch(() => undefined),
    private readonly budgetMs = PER_CHAT_FILE_COPY_SHARE_BUDGET_MS
  ) {
    this.windowStart = clock()
    this.taskStart = this.windowStart
  }

  /** Quit: no task waits for the next second any more. */
  stop(): void {
    this.stopping.abort()
  }

  /** A task of the copy begins: after a wait between runs, for one. */
  begin(): void {
    this.taskStart = this.clock()
  }

  /** Ends the copy's current task: on to the next macrotask, or, once this second's budget is
   *  spent, to the start of the next second. */
  yieldTask = async (): Promise<void> => {
    const now = this.clock()
    if (now - this.windowStart >= PER_CHAT_FILE_COPY_SHARE_WINDOW_MS) {
      this.windowStart = now
      this.used = 0
    }
    this.used += now - this.taskStart
    if (this.used >= this.budgetMs && !this.stopping.signal.aborted) {
      await this.wait(
        this.windowStart + PER_CHAT_FILE_COPY_SHARE_WINDOW_MS - now,
        this.stopping.signal
      )
      this.windowStart = this.clock()
      this.used = 0
    } else {
      await yieldToEventLoop()
    }
    this.taskStart = this.clock()
  }
}
