import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  structuredAgentSessionEntryReturning,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { structuredAgentSessionEntryAwaitsSettlement } from './structured-agent-session-outbox-admission'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'

function hostHeldIds(submissions: readonly AgentJournalSubmission[]): Set<string> {
  const held = handedOffQueuedMessageIds(submissions)
  for (const submission of submissions) {
    held.add(submission.clientMessageId)
  }
  return held
}

/** Whether this entry would still go out on its own: the host holds no row for it, nothing
 *  already owed settles it, and its text is not on its way back to the draft. */
function goesOutOnItsOwn(
  held: ReadonlySet<string>
): (entry: StructuredAgentSessionOutboxEntry) => boolean {
  return (entry) =>
    !held.has(entry.clientMessageId) &&
    !structuredAgentSessionEntryAwaitsSettlement(entry) &&
    !structuredAgentSessionEntryReturning(entry)
}

/**
 * What a Stop does to the outbox, before its request: nothing the journal does not already hold may
 * go out after it.
 * - A message that never went out is withdrawn here; its text goes back to the composer.
 * - One already on its way is stamped with the Stop's own id and never sent again: a resend onto the
 *   session the user stopped could start a turn. Its own answer, its journal row or the Stop's
 *   answer settles it (structured-agent-session-outbox-settlement).
 * - One the host holds a row for is the journal's to settle.
 */
export function stopStructuredAgentSessionOutbox(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  inFlightClientMessageId: string | null,
  stopOperationId: string
): {
  entries: StructuredAgentSessionOutboxEntry[]
  withdrawn: StructuredAgentSessionOutboxEntry[]
} {
  const goesOut = goesOutOnItsOwn(hostHeldIds(submissions))
  const kept: StructuredAgentSessionOutboxEntry[] = []
  const withdrawn: StructuredAgentSessionOutboxEntry[] = []
  for (const entry of entries) {
    if (!goesOut(entry)) {
      kept.push(entry)
    } else if (entry.lastAttemptAt === null && entry.clientMessageId !== inFlightClientMessageId) {
      withdrawn.push(entry)
    } else {
      kept.push({ ...entry, stoppedBy: { operationId: stopOperationId } })
    }
  }
  return { entries: kept, withdrawn }
}

/** Whether a Stop has something here to withdraw or stamp: a message that would still go out. */
export function hasUnsentStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): boolean {
  return entries.some(goesOutOnItsOwn(hostHeldIds(submissions)))
}
