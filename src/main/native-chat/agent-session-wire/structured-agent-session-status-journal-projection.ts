import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/structured-agent-session-command-entry'
// The status feed's per-journal projection, cached per commit: what a session's journal says its
// row is, and the user's newest send the provider accepted.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { structuredAgentSessionStopping } from './structured-agent-session-stopping'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  sequence: number
  fence: number | undefined
  /** The Stop marks' settle revision: a settle edge writes no row, so it is a key of its own. */
  stopRevision: number
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  /** A person's Stop is still ending the work it stopped (`structuredAgentSessionStopping`). */
  stopping: boolean
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
    const cursor = journal.cursor()
    // The conversation's fence, which a child's end moves: its unanswered sends stop counting.
    const fence = record?.lease.runtimeFence
    const stopRevision = journal.stopMarks.revision()
    let projection = this.byJournal.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.sequence !== cursor.sequence ||
      projection.fence !== fence ||
      projection.stopRevision !== stopRevision
    ) {
      // A journalled submission bumps `lastSequence`, so the send-time working
      // signal reaches the cache; the lease fence does not, hence the extra key.
      const submissions = journal.submissions()
      let firstInputSubmissionKey =
        projection?.epoch === cursor.epoch ? projection.firstInputSubmissionKey : null
      const start = projection?.epoch === cursor.epoch ? projection.submissionCount : 0
      // New submissions are visited once; streamed output cannot rescan command history.
      for (let index = start; !firstInputSubmissionKey && index < submissions.length; index++) {
        const submission = submissions[index]
        const item =
          journal.item(agentJournalSubmissionKey(submission.clientMessageId)) ??
          (submission.providerItemId ? journal.item(submission.providerItemId) : null)
        if (
          item?.body.kind === 'message' &&
          item.body.role === 'user' &&
          isRootAgentJournalItem(item) &&
          !isStructuredAgentSessionCommandEntry(item.body)
        ) {
          firstInputSubmissionKey = JSON.stringify([cursor.epoch, submission.clientMessageId])
        }
      }
      projection = {
        ...cursor,
        firstInputSubmissionKey,
        submissionCount: submissions.length,
        fence,
        stopRevision,
        // The journal's own projection, shared with the status it stores beside each write.
        state: journal.sessionStatus.at(fence),
        // From the submissions alone: rendering the whole journal for one key costs every commit.
        acceptedSendKey: newestAcceptedSendKey(cursor.epoch, submissions),
        // Only a chat with a Stop on record renders its journal for this.
        stopping:
          journal.stopMarks.latest() !== null &&
          structuredAgentSessionStopping(journal, journal.snapshot().items, submissions)
      }
      this.byJournal.set(journal, projection)
    }
    return projection
  }
}
