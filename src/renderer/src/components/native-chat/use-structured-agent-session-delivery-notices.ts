import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
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
    | 'retry'
    | 'retryInPlace'
    | 'retryHeld'
    | 'outbox'
    | 'submissions'
    | 'journalItems'
    | 'failedHere'
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
  return useMemo(
    () => withHeldRetries(deliveryNotices, controller.retryHeld),
    [deliveryNotices, controller.retryHeld]
  )
}

/** A Retry pressed while the host has not said how it can take it shows as pending until it has. */
export function withHeldRetries(
  notices: ReadonlyMap<string, NativeChatDeliveryNotice>,
  held: ReadonlySet<string>
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  if (held.size === 0) {
    return notices
  }
  const marked = new Map(notices)
  for (const clientMessageId of held) {
    const key = agentJournalSubmissionKey(clientMessageId)
    const notice = marked.get(key)
    if (notice?.onRetry) {
      marked.set(key, { ...notice, retryPending: true })
    }
  }
  return marked
}
