import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

export function useStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[],
  /** The whole outbox, where `outbox` leaves out the sends drawn as cards. */
  sentHere: readonly StructuredAgentSessionOutboxEntry[] = outbox
) {
  return useMemo(
    () =>
      projectStructuredAgentSessionMessages(items, outbox, submissions, queuedMessageIds, sentHere),
    [items, outbox, submissions, queuedMessageIds, sentHere]
  )
}
