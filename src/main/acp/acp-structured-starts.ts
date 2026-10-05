// The adapter's starts: each acquire under way, stopped when the host aborts its signal (a close,
// a Stop that must not wait behind it, or quit), and each failed start's child until its exit is
// proven, so a later close retries it instead of answering for a child it no longer knows.

import type { AcpStructuredChild } from './acp-structured-child'

export type AcpStartAttempt = {
  /** The host's: the start's one canceller. */
  readonly signal: AbortSignal
  child: AcpStructuredChild | null
}

export class AcpStructuredStarts {
  private readonly failed = new Map<string, AcpStructuredChild>()

  /** Registered before anything awaits, so an abort from here on stops this start. */
  begin(signal: AbortSignal | undefined): AcpStartAttempt {
    const attempt: AcpStartAttempt = { signal: signal ?? new AbortController().signal, child: null }
    attempt.signal.addEventListener('abort', () => void attempt.child?.close().catch(() => false), {
      once: true
    })
    return attempt
  }

  /** The start has its child; one already aborted goes as soon as it exists. */
  track(attempt: AcpStartAttempt, child: AcpStructuredChild): void {
    attempt.child = child
    if (attempt.signal.aborted) {
      void child.close().catch(() => false)
    }
  }

  /** A failed start whose child is not proven gone keeps it until its exit is. */
  retainFailed(sessionId: string, child: AcpStructuredChild): void {
    this.failed.set(sessionId, child)
    child.onExit(() => {
      if (this.failed.get(sessionId) === child) {
        this.failed.delete(sessionId)
      }
    })
  }

  /** Asks a failed start's child to stop again: true once none is left unproven. */
  async stopFailed(sessionId: string): Promise<boolean> {
    const child = this.failed.get(sessionId)
    if (!child) {
      return true
    }
    const proven = await child.close().catch(() => false)
    if (proven && this.failed.get(sessionId) === child) {
      this.failed.delete(sessionId)
    }
    return proven
  }

  failedSessionIds(): string[] {
    return [...this.failed.keys()]
  }
}
