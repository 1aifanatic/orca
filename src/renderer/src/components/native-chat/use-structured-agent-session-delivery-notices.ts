import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  failedStartsSentElsewhere,
  resendableFailedStartsSentElsewhere
} from '../../../../shared/structured-agent-session-failed-start-elsewhere'
import { isRetryingStructuredAgentSessionStart } from '../../../../shared/structured-agent-session-start-retry'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

/** The notice on each of the chat's own messages that did not go through, and their Retry. */
export function useStructuredAgentSessionDeliveryNotices(
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'retry' | 'send' | 'outbox' | 'submissions' | 'journalItems' | 'failedHere'
  >,
  agentLabel: string
) {
  // Read at click time, so the notices stay put while the outbox's Retry is rebuilt each render.
  const retryRef = useRef(controller.retry)
  useEffect(() => {
    retryRef.current = controller.retry
  })
  // A message sent from elsewhere that failed to start has no outbox entry here: its Retry sends
  // its words again as this desktop's own.
  const resendable = useMemo(
    () =>
      resendableFailedStartsSentElsewhere(
        controller.journalItems,
        controller.submissions,
        controller.outbox
      ),
    [controller.journalItems, controller.submissions, controller.outbox]
  )
  const resendRef = useRef({ resendable, send: controller.send })
  useEffect(() => {
    resendRef.current = { resendable, send: controller.send }
  })
  const retryDelivery = useCallback((clientMessageId: string) => {
    const words = resendRef.current.resendable.get(clientMessageId)
    if (words === undefined) {
      retryRef.current(clientMessageId)
    } else {
      resendRef.current.send(words, [], clientMessageId)
    }
  }, [])
  const canResend = useCallback(
    (clientMessageId: string) => resendable.has(clientMessageId),
    [resendable]
  )
  // Only a rejected message, or one waiting out a refused start, reads the journal's rows, so a new
  // batch of them re-renders no row else.
  const hasRejected = controller.outbox.some((entry) => entry.state === 'rejected')
  const rejectionRows =
    hasRejected ||
    controller.submissions.some(isRetryingStructuredAgentSessionStart) ||
    failedStartsSentElsewhere(controller.submissions, controller.outbox).length > 0
      ? controller.submissions
      : NO_SUBMISSIONS
  const startFailures = useStructuredAgentSessionStartFailureFacts(
    controller.journalItems,
    hasRejected
  )
  const deliveryNotices = useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        controller.outbox,
        agentLabel,
        retryDelivery,
        rejectionRows,
        startFailures,
        controller.failedHere,
        canResend
      ),
    [
      controller.outbox,
      agentLabel,
      retryDelivery,
      rejectionRows,
      startFailures,
      controller.failedHere,
      canResend
    ]
  )
  return deliveryNotices
}
