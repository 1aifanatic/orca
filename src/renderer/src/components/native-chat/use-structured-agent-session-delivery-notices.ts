import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { isRecoveredStructuredAgentSessionSubmission } from '../../../../shared/structured-agent-session-unanswered-dispatch'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { useStructuredAgentSessionCommandResultRows } from './use-structured-agent-session-command-result-rows'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

/** The structured chat's delivery notices, keyed by the message id each row renders under. */
export function useStructuredAgentSessionDeliveryNotices(input: {
  messages: readonly NativeChatMessage[]
  journalItems: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  agentLabel: string
  /** The agent is working or starting, so a lost outcome may still resolve. */
  agentActive: boolean
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentActive, agentLabel, outbox } = input
  // Only a message shown as not sent or not confirmed, or one still in this window's outbox,
  // reads the journal's rows, so a new batch of them re-renders no row else. Read from the
  // transcript and the journal, not this window's outbox: the host's record alone shows one.
  const hasNotSent =
    input.messages.some((message) => message.unsent === true) ||
    input.submissions.some(isRecoveredStructuredAgentSessionSubmission)
  const journalRows = hasNotSent || outbox.length > 0 ? input.submissions : NO_SUBMISSIONS
  const startFailures = useStructuredAgentSessionStartFailureFacts(input.journalItems, hasNotSent)
  const commandResults = useStructuredAgentSessionCommandResultRows(input.journalItems, hasNotSent)
  return useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        outbox,
        agentLabel,
        journalRows,
        startFailures,
        commandResults,
        agentActive
      ),
    [outbox, agentLabel, journalRows, startFailures, commandResults, agentActive]
  )
}
