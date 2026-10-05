// The adapter's starts: each acquire under way, stopped when the host aborts its signal (a close,
// a Stop that must not wait behind it, or quit), and each failed start's child until its exit is
// proven, so the next start or quit retries it instead of answering for a child it no longer knows.

import type { AcpStructuredChild } from './acp-structured-child'

export type AcpStartAttempt = {
  /** The host's: the start's one canceller. */
  readonly signal: AbortSignal
  child: AcpStructuredChild | null
  /** What the signal's abort does while the start runs; detached once it ends. */
  readonly stopChild: () => void
}

export class AcpStructuredStarts {
  private readonly failed = new Map<string, AcpStructuredChild>()

  /** Registered before anything awaits, so an abort from here on stops this start. */
  begin(signal: AbortSignal | undefined): AcpStartAttempt {
    const attempt: AcpStartAttempt = {
      signal: signal ?? new AbortController().signal,
      child: null,
      stopChild: () => void attempt.child?.close().catch(() => false)
    }
    attempt.signal.addEventListener('abort', attempt.stopChild, { once: true })
    return attempt
  }

  /** The start has its child; one already aborted goes as soon as it exists. */
  track(attempt: AcpStartAttempt, child: AcpStructuredChild): void {
    attempt.child = child
    if (attempt.signal.aborted) {
      void child.close().catch(() => false)
    }
  }

  /** A child the start handed over is the session's: an abort after this goes through its stop,
   *  which knows the close was asked for, not this listener, which would read as a crash. */
  end(attempt: AcpStartAttempt): void {
    attempt.signal.removeEventListener('abort', attempt.stopChild)
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
