import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  failedStartsSentElsewhere,
  retryableFailedStartsSentElsewhere
} from '../../../../shared/structured-agent-session-failed-start-elsewhere'
import { isRetryingStructuredAgentSessionStart } from '../../../../shared/structured-agent-session-start-retry'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []
const NO_IDS: ReadonlySet<string> = new Set()

/** The notice on each of the chat's own messages that did not go through, and their Retry. */
export function useStructuredAgentSessionDeliveryNotices(
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'retry' | 'retryInPlace' | 'outbox' | 'submissions' | 'journalItems' | 'failedHere'
  >,
  agentLabel: string
) {
  // Read at click time, so the notices stay put while the Retry is rebuilt each render.
  const retryRef = useRef({ retry: controller.retry, retryInPlace: controller.retryInPlace })
  useEffect(() => {
    retryRef.current = { retry: controller.retry, retryInPlace: controller.retryInPlace }
  })
  // A message sent from elsewhere that failed to start has no outbox entry here: a host that can
  // queues it again in place; an older one leaves it to its sender, so it reads with no Retry.
  const retryableElsewhere = useMemo(
    () =>
      controller.retryInPlace
        ? retryableFailedStartsSentElsewhere(controller.submissions, controller.outbox)
        : NO_IDS,
    [controller.retryInPlace, controller.submissions, controller.outbox]
  )
  const retryableElsewhereRef = useRef(retryableElsewhere)
  useEffect(() => {
    retryableElsewhereRef.current = retryableElsewhere
  })
  const retryDelivery = useCallback((clientMessageId: string) => {
    const { retry, retryInPlace } = retryRef.current
    if (retryInPlace && retryableElsewhereRef.current.has(clientMessageId)) {
      retryInPlace(clientMessageId)
    } else {
      retry(clientMessageId)
    }
  }, [])
  const canResend = useCallback(
    (clientMessageId: string) => retryableElsewhere.has(clientMessageId),
    [retryableElsewhere]
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
