import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAttachment } from '../../../../shared/structured-agent-session-send-mutation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  structuredAgentSessionQueueRequest,
  type StructuredAgentSessionQueueDelivery
} from './structured-agent-session-queue-request'
import {
  sendStructuredAgentSessionMessage,
  settleStructuredAgentSessionSendsFromJournal,
  stopStructuredAgentSessionSends
} from './structured-agent-session-message-sender'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice,
  subscribeToStructuredAgentSessionPendingSends
} from './structured-agent-session-pending-sends'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import { recoverLegacyStructuredAgentSessionOutbox } from './structured-agent-session-legacy-outbox'

/** The open chat's view of its sends: they live in the sender, which works without this view. */
export function useStructuredAgentSessionSends(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessageIds: readonly string[]
  queue: StructuredAgentSessionQueueDelivery
  /** The chat's history has loaded, so its rows and cards can answer for a legacy copy. */
  historyLoaded: boolean
  /** The chat reads Stopping: a send made now is drawn after the turn being stopped. */
  stopping?: boolean
}) {
  const {
    fence,
    historyLoaded,
    queue,
    queuedMessageIds,
    sessionId,
    stopping,
    submissions,
    target
  } = args
  const subscribe = useCallback(
    (listener: () => void) => subscribeToStructuredAgentSessionPendingSends(sessionId, listener),
    [sessionId]
  )
  const pending = useSyncExternalStore(subscribe, () =>
    getStructuredAgentSessionPendingSends(sessionId)
  )
  const notice = useSyncExternalStore(subscribe, () =>
    getStructuredAgentSessionSendNotice(sessionId)
  )

  useEffect(() => {
    noteStructuredAgentSessionFence(sessionId, fence)
  }, [fence, sessionId])

  useEffect(() => {
    settleStructuredAgentSessionSendsFromJournal(sessionId, submissions, queuedMessageIds)
  }, [pending, queuedMessageIds, sessionId, submissions])

  const recoverLegacy = historyLoaded && fence !== null
  useEffect(() => {
    if (recoverLegacy) {
      void recoverLegacyStructuredAgentSessionOutbox({
        sessionId,
        target,
        submissions,
        queuedMessageIds
      })
    }
    // Why: once per open, from the first loaded history; later batches add nothing it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoverLegacy, sessionId, target])

  const send = useCallback(
    (text: string, attachments: readonly StructuredAgentSessionAttachment[] = []): boolean => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      const delivery = structuredAgentSessionQueueRequest(queue, attachments)
      // Refused while the chat's send is out: the text stays in the box.
      return (
        sendStructuredAgentSessionMessage({
          sessionId,
          target,
          text,
          attachments,
          ...(delivery ? { delivery } : {}),
          ...(stopping ? { sentWhileStopping: true as const } : {})
        }) !== null
      )
    },
    [queue, sessionId, stopping, target]
  )

  return {
    pending,
    /** Why the last message came back to the composer, until the next send. */
    error: notice,
    send,
    stopSends: () => stopStructuredAgentSessionSends(sessionId)
  }
}
