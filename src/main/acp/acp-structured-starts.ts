// The adapter's starts: each acquire from its first step, so a close reaches it at any point (before
// the spawn too), and each failed start's child until its exit is proven, so a later close retries
// it instead of answering for a child it no longer knows.

import type { AcpStructuredChild } from './acp-structured-child'

export type AcpStartAttempt = { abandoned: boolean; child: AcpStructuredChild | null }

export class AcpStructuredStarts {
  private readonly starting = new Map<string, AcpStartAttempt>()
  private readonly failed = new Map<string, AcpStructuredChild>()

  /** Registered before anything awaits, so a close from here on stops this start. */
  begin(sessionId: string): AcpStartAttempt {
    const attempt: AcpStartAttempt = { abandoned: false, child: null }
    this.starting.set(sessionId, attempt)
    return attempt
  }

  /** The start has its child; one a close already reached goes as soon as it exists. */
  track(attempt: AcpStartAttempt, child: AcpStructuredChild): void {
    attempt.child = child
    if (attempt.abandoned) {
      void child.close().catch(() => false)
    }
  }

  end(sessionId: string, attempt: AcpStartAttempt): void {
    if (this.starting.get(sessionId) === attempt) {
      this.starting.delete(sessionId)
    }
  }

  /** The start under way, stopped: true once it has no child or that child's exit is proven. */
  async abandon(sessionId: string): Promise<boolean> {
    const attempt = this.starting.get(sessionId)
    if (!attempt) {
      return true
    }
    attempt.abandoned = true
    return attempt.child ? attempt.child.close().catch(() => false) : true
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

  sessionIds(): string[] {
    return [...this.starting.keys(), ...this.failed.keys()]
  }
}
