// What the host's chats are doing on the main thread, for work that must give way to them (the
// background copy of old chat files): a send handed to a provider and not yet answered, and every
// provider frame that reaches the main thread. Frames are the signal because streamed text and
// tool output are checkpointed into the journal, not written per delta, so a long answer can go
// many seconds between rows while the main thread parses every delta. A turn that is running but
// silent (a long tool call, a prompt waiting on the user) sends no frames and holds nothing.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { isUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-unanswered-dispatch'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionChatWork = {
  /** An open chat has a send handed to its provider and unanswered (a queued send is not). */
  sendInFlight: () => boolean
  /** Calls `listener` on every provider frame of any chat; returns the unsubscribe. */
  onActivity: (listener: () => void) => () => void
}

export class StructuredAgentSessionChatActivity implements StructuredAgentSessionChatWork {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly deps: {
      sessions: ReadonlyMap<string, { journal: AgentSessionJournal }>
      /** The conversation's fence: a send from an ended child is no longer in flight. */
      fence: (sessionId: string) => number | undefined
    }
  ) {}

  sendInFlight = (): boolean => {
    for (const [sessionId, { journal }] of this.deps.sessions) {
      const fence = this.deps.fence(sessionId)
      if (
        !journal.isReadOnly &&
        journal
          .submissions()
          .some(
            (submission) =>
              !isQueuedAgentJournalSubmission(submission) &&
              isUnansweredStructuredAgentSessionDispatch(submission, fence)
          )
      ) {
        return true
      }
    }
    return false
  }

  onActivity = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A provider frame for an open chat reached the main thread. */
  noteFrame = (): void => {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
