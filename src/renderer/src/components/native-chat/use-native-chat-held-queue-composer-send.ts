// A message sent while the queue is held asks first whether to clear the cards, which would
// otherwise wait behind it. A host command is not a message and sends as it is.

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  isNativeChatStructuredHostCommand,
  useNativeChatStructuredComposerSend,
  type UseNativeChatStructuredComposerSendArgs
} from './use-native-chat-structured-composer-send'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

type StructuredComposerSend = (
  text: string,
  attachments?: readonly NativeChatComposerImageAttachment[]
) => void

/** The confirmation as the dialog shows it; kept after it closes so the closing frame still reads. */
export type NativeChatQueueSendConfirm = {
  open: boolean
  /** The cards waiting when it opened. */
  count: number
  /** Delete every card, then send; a failed delete sends nothing. */
  clearQueue: () => void
  /** Send and keep the cards: the message is the person's turn, so they follow it. */
  sendMessage: () => void
  /** Send nothing; the draft and its attachments stay in the composer. */
  dismiss: () => void
}

type PendingSend = {
  text: string
  attachments: readonly NativeChatComposerImageAttachment[] | undefined
  count: number
  clear: () => Promise<boolean>
}

export function useNativeChatHeldQueueComposerSend(args: UseNativeChatStructuredComposerSendArgs): {
  send: StructuredComposerSend
  confirm: NativeChatQueueSendConfirm | null
} {
  const sendNow = useNativeChatStructuredComposerSend(args)
  const { agent, structuredTransport } = args
  const queueHold = structuredTransport?.queueHold
  const [pending, setPending] = useState<PendingSend | null>(null)
  const [open, setOpen] = useState(false)
  // Clear queue sends once its deletes settle, through the send of that render.
  const sendNowRef = useRef(sendNow)
  useLayoutEffect(() => {
    sendNowRef.current = sendNow
  }, [sendNow])

  const send = useCallback<StructuredComposerSend>(
    (text, attachments) => {
      if (
        queueHold &&
        structuredTransport &&
        !isNativeChatStructuredHostCommand(text, agent, structuredTransport)
      ) {
        setPending({ text, attachments, count: queueHold.count, clear: queueHold.clear })
        setOpen(true)
        return
      }
      sendNow(text, attachments)
    },
    [agent, queueHold, sendNow, structuredTransport]
  )

  const sendMessage = useCallback(() => {
    setOpen(false)
    if (pending) {
      sendNowRef.current(pending.text, pending.attachments)
    }
  }, [pending])
  const clearQueue = useCallback(() => {
    setOpen(false)
    if (!pending) {
      return
    }
    void pending.clear().then((cleared) => {
      if (cleared) {
        sendNowRef.current(pending.text, pending.attachments)
      }
    })
  }, [pending])
  const dismiss = useCallback(() => setOpen(false), [])

  const confirm = pending ? { open, count: pending.count, clearQueue, sendMessage, dismiss } : null
  return { send, confirm }
}
