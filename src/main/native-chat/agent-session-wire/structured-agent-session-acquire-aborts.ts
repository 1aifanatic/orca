// The acquire each session has in flight, owned by the host that runs it. The session's queue runs
// one attach at a time, so a session has at most one; a close, or a Stop admitted now, aborts it
// from outside the queue instead of waiting behind a start the provider may never answer.

export class StructuredAgentSessionAcquireAborts {
  private readonly inFlight = new Map<string, AbortController>()

  /** For the attach about to run; `end` once it settles. */
  begin(sessionId: string): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController()
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
}
