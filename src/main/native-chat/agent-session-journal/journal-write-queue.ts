// One chat's write queue: build, commit and adopt run one at a time, in arrival order.
//
// Closing is admission only. A closed store refuses new writes forever, so a stale reference
// (an event sink, a late callback) can never append from a fold a newer open has replaced; the
// writes already admitted still land, and `drain` resolves once they have.

import { AgentSessionJournalError } from './journal-write-guards'

/** Admission is checked at ENQUEUE and is permanent. */
export class JournalWriteQueue {
  private writes: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly sessionId: string) {}

  markClosed(): void {
    this.closed = true
  }

  serialize<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new AgentSessionJournalError(
          'journal_closed',
          `agent-session journal for ${this.sessionId} is closed`
        )
      )
    }
    return this.serializePastGate(run)
  }

  /** Resolves once every write admitted so far has settled, whatever its outcome. */
  drain(): Promise<void> {
    return this.writes.then(() => undefined)
  }

  private serializePastGate<T>(run: () => Promise<T>): Promise<T> {
    const started = this.writes.then(run)
    this.writes = started.catch(() => undefined)
    return started
  }
}
