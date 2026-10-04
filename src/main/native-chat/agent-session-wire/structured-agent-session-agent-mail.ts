// What a host-side sender reads and changes of its own agents' mail in one conversation: every
// draft, settled ones included, and every send with the agent it is from. Host-only; clients read
// the published lists, which carry no source.

import { randomUUID } from 'node:crypto'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import { withdrawQueuedMessagesForOperation } from './structured-agent-session-queued-mutations'

export type StructuredAgentMailFacts = {
  cards: readonly QueuedMessageRow[]
  sends: readonly { submission: AgentJournalSubmission; source: AgentMessageSource | undefined }[]
}

export function structuredAgentMailFacts(journal: AgentSessionJournal): StructuredAgentMailFacts {
  return {
    cards: journal.queuedMessages.list(),
    sends: journal.submissions().map((submission) => ({
      submission,
      source: journal.submissionSource(submission.clientMessageId)
    }))
  }
}

/** Withdraws the sender's own agents' cards where still waiting or returned, stamped with its
 *  `callerKey`; answers which it withdrew. */
export async function withdrawStructuredAgentCards(
  journal: AgentSessionJournal,
  input: { sessionId: string; cardIds: readonly string[]; callerKey: string }
): Promise<readonly string[]> {
  const withdrawn = await withdrawQueuedMessagesForOperation(journal, {
    sessionId: input.sessionId,
    messageIds: input.cardIds.filter(
      (id) => journal.queuedMessages.get(id)?.source.kind === 'agent'
    ),
    callerKey: input.callerKey,
    operationId: randomUUID()
  })
  return withdrawn.map((row) => row.messageId)
}
