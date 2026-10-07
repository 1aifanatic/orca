// The summary the status feed last published for each chat, with the first input it was projected
// with. Never evicted: chats are named only while in here, and AI Vault reads closed ones' names here.

import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

type StructuredAgentSessionStatusPublication = {
  summary: AgentSessionStatusSummary
  firstInputSubmissionKey: string | null
}

export class StructuredAgentSessionStatusPublications {
  private readonly bySession = new Map<string, StructuredAgentSessionStatusPublication>()

  get(sessionId: string): StructuredAgentSessionStatusPublication | undefined {
    return this.bySession.get(sessionId)
  }

  summaries(): AgentSessionStatusSummary[] {
    return [...this.bySession.values()].map(({ summary }) => summary)
  }

  set(
    sessionId: string,
    summary: AgentSessionStatusSummary,
    firstInputSubmissionKey: string | null
  ): void {
    this.bySession.set(sessionId, { summary, firstInputSubmissionKey })
  }

  /** The row's summary changed outside a projection; the input it was projected with stays. */
  replace(sessionId: string, summary: AgentSessionStatusSummary): void {
    this.set(sessionId, summary, this.bySession.get(sessionId)?.firstInputSubmissionKey ?? null)
  }
}
