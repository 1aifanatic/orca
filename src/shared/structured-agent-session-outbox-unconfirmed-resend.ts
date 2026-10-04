// Which send in doubt Orca resends on its own under the same id.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryAwaitsSettlement } from './structured-agent-session-outbox-admission'

/** Whether the unconfirmed probe resends this entry: in doubt, not outrun by a Stop, and with no
 *  journal row yet. Any row ends it: the journal answers from there. */
export function structuredAgentSessionEntryResendsUnconfirmed(
  entry: StructuredAgentSessionOutboxEntry,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  return (
    entry.state === 'unconfirmed' &&
    !structuredAgentSessionEntryAwaitsSettlement(entry) &&
    !submissions.some((submission) => submission.clientMessageId === entry.clientMessageId)
  )
}
