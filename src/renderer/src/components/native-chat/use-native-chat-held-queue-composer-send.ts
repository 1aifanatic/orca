// A message sent while the queue is held asks first whether to clear the cards, which would
// otherwise wait behind it. A host command is not a message and sends as it is.

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  isNativeChatStructuredHostCommand,
  useNativeChatStructuredComposerSend,
  type NativeChatComposerComposition,
  type NativeChatStructuredComposerSend,
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
  /** The composer as it was when the message was asked for. */
  sentFrom: NativeChatComposerComposition
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
  // The send a choice may still take, taken once: the closing dialog stays clickable for its exit
  // animation, and a double-click or a held Enter lands twice before any re-render.
  const untakenRef = useRef<PendingSend | null>(null)
  const take = useCallback((): PendingSend | null => {
    const taken = untakenRef.current
    untakenRef.current = null
    setOpen(false)
    return taken
  }, [])
  // Clear queue sends once its deletes settle, through the send of that render.
  const sendNowRef = useRef<NativeChatStructuredComposerSend>(sendNow)
  const compositionRef = useRef<NativeChatComposerComposition>({
    draft: args.draft,
    imageAttachments: args.imageAttachments
  })
  useLayoutEffect(() => {
    sendNowRef.current = sendNow
    compositionRef.current = { draft: args.draft, imageAttachments: args.imageAttachments }
  }, [args.draft, args.imageAttachments, sendNow])
  // From a Clear queue choice until its message has gone out: the draft still holds that message,
  // and sending it again meanwhile would send it twice.
  const clearingRef = useRef(false)

  const send = useCallback<StructuredComposerSend>(
    (text, attachments) => {
      if (clearingRef.current) {
        return
      }
      if (
        queueHold &&
        structuredTransport &&
        !isNativeChatStructuredHostCommand(text, agent, structuredTransport)
      ) {
        const asked = {
          text,
          attachments,
          count: queueHold.count,
          clear: queueHold.clear,
          sentFrom: compositionRef.current
        }
        untakenRef.current = asked
        setPending(asked)
        setOpen(true)
        return
      }
      void sendNow(text, attachments)
    },
    [agent, queueHold, sendNow, structuredTransport]
  )

  const sendMessage = useCallback(() => {
    const taken = take()
    if (taken) {
      void sendNowRef.current(taken.text, taken.attachments, taken.sentFrom)
    }
  }, [take])
  const clearQueue = useCallback(() => {
    const taken = take()
    if (!taken) {
      return
    }
    clearingRef.current = true
    void (async () => {
      try {
        if (await taken.clear()) {
          // Text typed during the deletes stays: the message was taken from what came before.
          await sendNowRef.current(taken.text, taken.attachments, taken.sentFrom)
        }
      } finally {
        clearingRef.current = false
      }
    })()
  }, [take])
  const dismiss = useCallback(() => {
    take()
  }, [take])

  const confirm = pending ? { open, count: pending.count, clearQueue, sendMessage, dismiss } : null
  return { send, confirm }
}
