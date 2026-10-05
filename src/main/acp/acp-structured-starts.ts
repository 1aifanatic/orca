// The adapter's starts: each acquire under way, stopped when its signal aborts (a close or a Stop
// that must not wait behind it) or at quit, and each failed start's child until its exit is
// proven, so a later close retries it instead of answering for a child it no longer knows.

import type { AcpStructuredChild } from './acp-structured-child'

export type AcpStartAttempt = {
  /** Aborted by the acquire's own signal, or by quit. */
  readonly signal: AbortSignal
  child: AcpStructuredChild | null
}

export class AcpStructuredStarts {
  /** Each start under way, with what quit aborts it by. */
  private readonly starting = new Map<AcpStartAttempt, AbortController>()
  private readonly failed = new Map<string, AcpStructuredChild>()

  /** Registered before anything awaits, so an abort from here on stops this start. */
  begin(signal: AbortSignal | undefined): AcpStartAttempt {
    const quit = new AbortController()
    const attempt: AcpStartAttempt = {
      signal: signal ? AbortSignal.any([signal, quit.signal]) : quit.signal,
      child: null
    }
    attempt.signal.addEventListener('abort', () => void attempt.child?.close().catch(() => false), {
      once: true
    })
    this.starting.set(attempt, quit)
    return attempt
  }

  /** The start has its child; one already aborted goes as soon as it exists. */
  track(attempt: AcpStartAttempt, child: AcpStructuredChild): void {
    attempt.child = child
    if (attempt.signal.aborted) {
      void child.close().catch(() => false)
    }
  }

  end(attempt: AcpStartAttempt): void {
    this.starting.delete(attempt)
  }

  /** Quit: every start under way stops; true once none has a child left unproven gone. */
  async stopAll(): Promise<boolean> {
    const proven = await Promise.all(
      [...this.starting].map(([attempt, quit]) => {
        quit.abort()
        return attempt.child ? attempt.child.close().catch(() => false) : true
      })
    )
    return !proven.includes(false)
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
