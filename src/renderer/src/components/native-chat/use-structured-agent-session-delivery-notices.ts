import { useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'
import { useStructuredAgentSessionCommandResultRows } from './use-structured-agent-session-command-result-rows'
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
  const commandResults = useStructuredAgentSessionCommandResultRows(args.journalItems, hasRejected)
  const notices = useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        outbox,
        agentName,
        retry,
        rejectionRows,
        startFailures,
        failedHere,
        queuedMessageIds,
        commandResults
      ),
    [
      outbox,
      agentName,
      retry,
      rejectionRows,
      startFailures,
      failedHere,
      queuedMessageIds,
      commandResults
    ]
  )
  // A submission batch rebuilds the map; one that says the same keeps the old, so no row re-renders.
  const previousRef = useRef(notices)
  const stable = sameNoticesKept(previousRef.current, notices)
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

/** `next`, reusing each notice `previous` words the same way, and `previous` itself when all are. */
function sameNoticesKept(
  previous: ReadonlyMap<string, NativeChatDeliveryNotice>,
  next: ReadonlyMap<string, NativeChatDeliveryNotice>
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  if (previous === next) {
    return next
  }
  let allKept = previous.size === next.size
  const kept = new Map<string, NativeChatDeliveryNotice>()
  for (const [id, notice] of next) {
    const before = previous.get(id)
    // Each Retry calls the stable `retry` with its own id, so one under the same key is the same.
    const same =
      before !== undefined &&
      before.text === notice.text &&
      (before.onRetry === undefined) === (notice.onRetry === undefined) &&
      (before.onDismiss === undefined) === (notice.onDismiss === undefined)
    allKept &&= same
    kept.set(id, same ? before : notice)
  }
  return allKept ? previous : kept
}
