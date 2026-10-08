// The order of what a conversation's record learns about its child's options.
//
// A pick and a child's report both write the record's options, but a report describes the child as
// of its read, which can predate a pick still in flight, a saved value the child showed it cannot
// run, or a newer report. Each of those moves the revision. A report carries the revision it was
// read at and is persisted only if nothing moved it since, so no read undoes what followed it.

export class StructuredAgentSessionOptionRevisions {
  private readonly revisions = new Map<string, number>()

  current(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0
  }

  /** What any report read before now says is out of date. */
  advance(sessionId: string): number {
    const next = this.current(sessionId) + 1
    this.revisions.set(sessionId, next)
    return next
  }

  /** A report read at `readAt` becomes the newest word, or null when a pick or report came since. */
  admitReport(sessionId: string, readAt: number): number | null {
    return readAt === this.current(sessionId) ? this.advance(sessionId) : null
  }

  /** The conversation closed with no child: nothing it reported is still to be persisted. */
  forget(sessionId: string): void {
    this.revisions.delete(sessionId)
  }
}
