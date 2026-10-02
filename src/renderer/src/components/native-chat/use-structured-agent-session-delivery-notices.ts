import { useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

/** The structured chat's delivery notices, by the message id each row renders under. */
export function useStructuredAgentSessionDeliveryNotices(args: {
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
  journalItems: readonly AgentJournalRenderItem[]
  failedHere: ReadonlySet<string>
  queuedMessageIds: readonly string[]
  retry: (clientMessageId: string) => void
  agentName: string
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, failedHere, outbox, queuedMessageIds, submissions } = args
  // Read at click time, so the notices stay put while the outbox's Retry is rebuilt each render.
  const retryRef = useRef(args.retry)
  useEffect(() => {
    retryRef.current = args.retry
  })
  const retry = useCallback((clientMessageId: string) => {
    retryRef.current(clientMessageId)
  }, [])
  // Only a message shown as not sent reads the journal's rows (a withdrawn one draws nothing), so
  // in a chat without one a new batch of them re-renders no row.
  const hasRejected =
    outbox.some((entry) => entry.state === 'rejected') ||
    submissions.some(
      (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
    )
  const rejectionRows = hasRejected ? submissions : NO_SUBMISSIONS
  const startFailures = useStructuredAgentSessionStartFailureFacts(args.journalItems, hasRejected)
  return useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        outbox,
        agentName,
        retry,
        rejectionRows,
        startFailures,
        failedHere,
        queuedMessageIds
      ),
    [outbox, agentName, retry, rejectionRows, startFailures, failedHere, queuedMessageIds]
  )
}
