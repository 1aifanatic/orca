import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAttachment } from '../../../../shared/structured-agent-session-send-mutation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { StructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import {
  sendStructuredAgentSessionMessage,
  settleStructuredAgentSessionSendsFromJournal,
  stopStructuredAgentSessionSends
} from './structured-agent-session-message-sender'
import {
  clearStructuredAgentSessionSendNotice,
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice,
  subscribeToStructuredAgentSessionPendingSends
} from './structured-agent-session-pending-sends'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import { recoverLegacyStructuredAgentSessionOutbox } from './structured-agent-session-legacy-outbox'

/** Whether the host holds a send as a card while the agent works: only a host that says it queues,
 *  with the setting on, and only text, which is all its queue takes. */
function queueRequest(
  queue: { capability: StructuredAgentSessionHostCapabilityState; enabled: boolean },
  attachments: readonly StructuredAgentSessionAttachment[]
): 'queue-if-active' | undefined {
  return queue.capability === 'supported' && queue.enabled && attachments.length === 0
    ? 'queue-if-active'
    : undefined
}

/** The open chat's view of its sends: they live in the sender, which works without this view. */
export function useStructuredAgentSessionSends(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessageIds: readonly string[]
  queue: { capability: StructuredAgentSessionHostCapabilityState; enabled: boolean }
  /** The chat's history has loaded, so its rows and cards can answer for a legacy copy. */
  historyLoaded: boolean
}) {
  const { fence, historyLoaded, queue, queuedMessageIds, sessionId, submissions, target } = args
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
      const delivery = queueRequest(queue, attachments)
      // Refused while the chat's send is out: the text stays in the box.
      return (
        sendStructuredAgentSessionMessage({
          sessionId,
          target,
          text,
          attachments,
          ...(delivery ? { delivery } : {})
        }) !== null
      )
    },
    [queue, sessionId, target]
  )

  return {
    pending,
    /** Why the last message came back to the composer, until the next send. */
    error: notice,
    clearError: () => clearStructuredAgentSessionSendNotice(sessionId),
    send,
    stopSends: () => stopStructuredAgentSessionSends(sessionId)
  }
}
