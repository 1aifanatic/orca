// The background copy's share of the main thread: each of its tasks ends by yielding here, and a
// task that takes more than the copy's share so far waits until the share catches up (a token
// bucket refilled at the share, holding at most a small burst). So any second gives the copy at
// most the share, the burst and the one task that crossed it, except while it gives way (below):
// then the rest of that chat runs unpaced, and its debt is paid after it.
//
// Inside a chat the copy holds that chat's lock, so a wait there would hold up anyone who opens or
// commands it: there the pace gives way, skipping its wait while anyone waits for the chat and
// ending one when someone starts to, and keeps the debt for the next yield between chats, which
// holds no lock. Awaits that are not the copy's own work (a lock, a disk probe) are not charged.
// Quit ends any wait at once: the copy then stops at its next batch.

import { performance } from 'node:perf_hooks'
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { StructuredAgentSessionChatLocks } from './structured-agent-session-task-queue'

/** The copy's share of the main thread's wall time, waits on disk included. */
export const PER_CHAT_FILE_COPY_SHARE = 0.15
/** Main-thread time the copy may take at once after it has been idle. */
export const PER_CHAT_FILE_COPY_BURST_MS = 50

/** Someone waiting for the chat the copy holds. */
type PerChatFileCopyGiveWay = {
  /** Someone is waiting now. */
  now: () => boolean
  /** Resolves when someone starts waiting, or once `signal` aborts. */
  next: (signal: AbortSignal) => Promise<void>
}

export class StructuredAgentSessionPerChatFileCopyPace {
  private tokens = PER_CHAT_FILE_COPY_BURST_MS
  private refilledAt: number
  private taskStart: number
  private counting = true
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

  /** A task of the copy begins: after a wait between runs, or after an uncharged await. */
  begin(): void {
    this.taskStart = this.clock()
    this.counting = true
  }

  /** Charges the task so far, and charges nothing more until `begin`: for an await that is not
   *  the copy's own work. */
  pause(): void {
    this.charge()
    this.counting = false
  }

  /** Ends the copy's current task between chats: on to the next macrotask, or, when the copy has
   *  taken more than its share, after a wait that brings the share back. */
  yieldTask = async (): Promise<void> => {
    this.charge()
    await this.repay(null)
    this.begin()
  }

  /** Runs `task` inside the chat's lock. The wait for the lock is not charged, and the task's
   *  yields give way to anyone who waits for the chat meanwhile (see the header). */
  inChat<T>(
    locks: StructuredAgentSessionChatLocks,
    sessionId: string,
    task: (yieldTask: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const giveWay: PerChatFileCopyGiveWay = {
      now: () => locks.hasQueuedBehind(sessionId),
      next: (signal) => locks.nextQueued(sessionId, signal)
    }
    this.pause()
    return locks.serialize(sessionId, () => {
      this.begin()
      return task(() => this.yieldGivingWay(giveWay))
    })
  }

  private async yieldGivingWay(giveWay: PerChatFileCopyGiveWay): Promise<void> {
    this.charge()
    await this.repay(giveWay.now() ? 'skip' : giveWay)
    this.begin()
  }

  private charge(): void {
    if (!this.counting) {
      return
    }
    const now = this.clock()
    // Refilled while idle before the task, up to the burst; the task refills as it spends.
    this.tokens = Math.min(
      PER_CHAT_FILE_COPY_BURST_MS,
      this.tokens + (this.taskStart - this.refilledAt) * PER_CHAT_FILE_COPY_SHARE
    )
    this.tokens -= (now - this.taskStart) * (1 - PER_CHAT_FILE_COPY_SHARE)
    this.refilledAt = now
    this.taskStart = now
  }

  private async repay(giveWay: PerChatFileCopyGiveWay | 'skip' | null): Promise<void> {
    if (this.tokens >= 0 || this.stopping.signal.aborted || giveWay === 'skip') {
      await yieldToEventLoop()
      return
    }
    const gaveWay = new AbortController()
    void giveWay?.next(gaveWay.signal).then(() => gaveWay.abort())
    const from = this.clock()
    await this.wait(
      -this.tokens / PER_CHAT_FILE_COPY_SHARE,
      AbortSignal.any([this.stopping.signal, gaveWay.signal])
    )
    gaveWay.abort()
    const now = this.clock()
    this.tokens = Math.min(0, this.tokens + (now - from) * PER_CHAT_FILE_COPY_SHARE)
    this.refilledAt = now
  }
}
