import { useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
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
  failedHere: ReadonlySet<string>
  retry: (clientMessageId: string) => void
  agentLabel: string
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { outbox, failedHere, agentLabel } = input
  // Read at click time, so the notices stay put while the outbox's Retry is rebuilt each render.
  const retryRef = useRef(input.retry)
  useEffect(() => {
    retryRef.current = input.retry
  })
  const retry = useCallback((clientMessageId: string) => {
    retryRef.current(clientMessageId)
  }, [])
  // Only a row shown as not sent reads the journal's rows, so a new batch of them re-renders no row
  // else. Read from the transcript, not this window's outbox: the host's record alone shows one.
  const hasNotSent = input.messages.some((message) => message.unsent === true)
  const rejectionRows = hasNotSent ? input.submissions : NO_SUBMISSIONS
  const startFailures = useStructuredAgentSessionStartFailureFacts(input.journalItems, hasNotSent)
  const commandResults = useStructuredAgentSessionCommandResultRows(input.journalItems, hasNotSent)
  return useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        outbox,
        agentLabel,
        retry,
        rejectionRows,
        startFailures,
        failedHere,
        commandResults
      ),
    [outbox, agentLabel, retry, rejectionRows, startFailures, failedHere, commandResults]
  )
}
