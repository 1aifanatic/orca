// Which chats the host holds open owe work, from the projection behind the status feed's rows: a
// turn running or a send journaled that the provider has not answered, even beneath a pending
// prompt (a row then reads `attention`), whatever the provider.

import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

const OWING: ReadonlySet<AgentSessionStatusSummary['status']> = new Set(['working', 'attention'])

export class StructuredAgentSessionWorkingChats {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly open: () => ReadonlyMap<string, unknown>,
    /** The projection's `owesWork` for an open chat. */
    private readonly owesWork: (sessionId: string) => boolean
  ) {}

  any(): boolean {
    for (const [sessionId] of this.open()) {
      if (this.owesWork(sessionId)) {
        return true
      }
    }
    return false
  }

  /** Calls `listener` each time an open chat is published owing work, or after it may have;
   *  returns the unsubscribe. */
  onWork(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** From the feed, after it published `summary` over `previous`. A row that could have owed work
   *  (`working`, or `attention` over a running turn) counts, so its end is timed too. */
  publishedSummary(summary: AgentSessionStatusSummary, previous?: AgentSessionStatusSummary): void {
    const { sessionId } = summary
    if (!this.open().get(sessionId)) {
      return
    }
    if (this.owesWork(sessionId) || (previous && OWING.has(previous.status))) {
      for (const listener of this.listeners) {
        listener()
      }
    }
  }
}
