// The acquire each session has in flight, owned by the host that runs it. The session's queue runs
// one attach at a time, so a session has at most one; a close, a Stop admitted now, or quit aborts
// it from outside the queue instead of waiting behind a start the provider may never answer.

export class StructuredAgentSessionAcquireAborts {
  private readonly inFlight = new Map<string, AbortController>()
  /** Set by quit: the host is going away, so an attach that begins after it starts aborted. */
  private quitReason: Error | null = null

  /** For the attach about to run; `end` once it settles. */
  begin(sessionId: string): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController()
    if (this.quitReason) {
      controller.abort(this.quitReason)
    }
    this.inFlight.set(sessionId, controller)
    return {
      signal: controller.signal,
      end: () => {
        if (this.inFlight.get(sessionId) === controller) {
          this.inFlight.delete(sessionId)
        }
      }
    }
  }

  /** A no-op when the session has nothing in flight. */
  abort(sessionId: string, reason: string): void {
    this.inFlight.get(sessionId)?.abort(new Error(reason))
  }

  /** Quit: every start under way stops, and so does any the attach drain still runs. */
  abortAll(reason: string): void {
    this.quitReason ??= new Error(reason)
    for (const controller of this.inFlight.values()) {
      controller.abort(this.quitReason)
    }
  }
}
