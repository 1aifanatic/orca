// Which chats the host holds open are working, from the summaries the status feed published: a
// turn running, or a send journaled that the provider has not answered, whatever the provider.

import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

export class StructuredAgentSessionWorkingChats {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly open: () => ReadonlyMap<string, unknown>,
    private readonly published: ReadonlyMap<string, AgentSessionStatusSummary>
  ) {}

  any(): boolean {
    for (const [sessionId] of this.open()) {
      if (this.published.get(sessionId)?.status === 'working') {
        return true
      }
    }
    return false
  }

  /** Calls `listener` each time an open chat is published working, or no longer working;
   *  returns the unsubscribe. */
  onWork(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** From the feed, after it published `summary` over `previous`. */
  publishedSummary(summary: AgentSessionStatusSummary, previous?: AgentSessionStatusSummary): void {
    const work = summary.status === 'working' || previous?.status === 'working'
    if (work && this.open().get(summary.sessionId)) {
      for (const listener of this.listeners) {
        listener()
      }
    }
  }
}
