// Local actions reveal this pane. Answers and Resume wait for host acceptance,
// preserving any newer reader navigation; passive host delivery never reveals it.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  useNativeChatRevealLatest,
  type NativeChatMessageListHandle
} from './use-native-chat-reveal-latest'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

type StructuredController = ReturnType<typeof useStructuredAgentSession>

export function useStructuredNativeChatSubmitReveal(
  controller: Pick<StructuredController, 'respond' | 'retry' | 'queuedMessages'>,
  /** Relaunches a start that failed; the messages parked behind it go out on publish. */
  retryLaunch: () => void
): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  /** For the composer's transport, which knows when a send was accepted. */
  revealLatest: () => void
  holdRevealLatest: () => () => void
  retryDelivery: (clientMessageId: string) => void
  retryLaunch: () => void
  respond: StructuredController['respond']
  queuedMessages: StructuredAgentSessionQueuedMessagesController
} {
  const { messageListRef, revealLatest, holdRevealLatest } = useNativeChatRevealLatest()
  const { respond, queuedMessages } = controller
  // Read at click time, so the notices stay put while the outbox's Retry is rebuilt each render.
  const retryRef = useRef(controller.retry)
  useEffect(() => {
    retryRef.current = controller.retry
  })
  const retryDelivery = useCallback(
    (clientMessageId: string) => {
      revealLatest()
      retryRef.current(clientMessageId)
    },
    [revealLatest]
  )
  const revealingRetryLaunch = useCallback(() => {
    revealLatest()
    retryLaunch()
  }, [retryLaunch, revealLatest])
  const revealingRespond = useCallback<StructuredController['respond']>(
    async (...args) => {
      // Held from the click: a reader who scrolls away while the host decides stays there.
      const reveal = holdRevealLatest()
      const result = await respond(...args)
      // Null is a refused or failed answer: nothing was sent, so the reader stays put.
      if (result !== null) {
        reveal()
      }
      return result
    },
    [holdRevealLatest, respond]
  )
  const revealingQueue = useMemo<StructuredAgentSessionQueuedMessagesController>(
    () => ({
      ...queuedMessages,
      steer: (messageId) => {
        revealLatest()
        return queuedMessages.steer(messageId)
      },
      resume: async () => {
        const reveal = holdRevealLatest()
        const resumed = await queuedMessages.resume()
        if (resumed) {
          reveal()
        }
        return resumed
      },
      steerNewest: () => {
        const steered = queuedMessages.steerNewest()
        if (steered) {
          revealLatest()
        }
        return steered
      }
    }),
    [holdRevealLatest, queuedMessages, revealLatest]
  )
  return {
    messageListRef,
    revealLatest,
    holdRevealLatest,
    retryDelivery,
    retryLaunch: revealingRetryLaunch,
    respond: revealingRespond,
    queuedMessages: revealingQueue
  }
}
