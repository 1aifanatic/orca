// The status feed's per-journal projection, cached per commit: what a session's journal says its
// row is, and the newest root turn it holds.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { newestRootTurnId } from './structured-agent-session-status-child-work'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  sequence: number
  readOnly: boolean
  fence: number | undefined
  state: StructuredAgentSessionStatusState
  rootTurnId: string | null
}

export class StructuredAgentSessionJournalProjections {
  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  read(
    journal: AgentSessionJournal,
    record: AgentSessionRecord | null
  ): StructuredAgentSessionJournalProjection {
    // An unreadable journal projects as "no turn": the chat itself shows the reset.
    const cursor = journal.cursor()
    const readOnly = journal.isReadOnly
    // The conversation's fence, which a child's end moves: its unanswered sends stop counting.
    const fence = record?.lease.runtimeFence
    let projection = this.byJournal.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.sequence !== cursor.sequence ||
      projection.readOnly !== readOnly ||
      projection.fence !== fence
    ) {
      // A journalled submission bumps `lastSequence`, so the send-time working
      // signal reaches the cache; the lease fence does not, hence the extra key.
      const snapshot = readOnly ? null : journal.snapshot()
      projection = {
        ...cursor,
        readOnly,
        fence,
        state: projectStructuredAgentSessionStatusState(
          snapshot?.items ?? [],
          snapshot?.submissions ?? [],
          fence
        ),
        rootTurnId: newestRootTurnId(snapshot?.items ?? [])
      }
      this.byJournal.set(journal, projection)
    }
    return projection
  }
}
