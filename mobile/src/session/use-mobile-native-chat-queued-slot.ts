// The queued-draft cards' place in the chat view, built outside it: the cards to show between the
// transcript and the composer, and the composer ref their Edit focuses.

import { createElement, useMemo, type ReactNode, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  MobileNativeChatQueuedMessages,
  type MobileNativeChatQueuedMessagesProps
} from './MobileNativeChatQueuedMessages'
import { useMobileNativeChatQueuedEditFocus } from './use-mobile-native-chat-queued-edit-focus'

export type MobileNativeChatQueuedSlot = {
  cards?: ReactNode
  composerInputRef?: RefObject<TextInput | null>
}

export type MobileQueuedSlotProps = {
  /** Host-held queued drafts, rendered as cards between transcript and composer. */
  queuedSlot?: MobileNativeChatQueuedSlot
}

/** A view given no slot shows no cards; one stable object, so the default never re-renders. */
export const NO_QUEUED_SLOT: MobileNativeChatQueuedSlot = {}

export function useMobileNativeChatQueuedSlot(
  queuedMessages: MobileNativeChatQueuedMessagesProps
): MobileNativeChatQueuedSlot {
  const { composerInputRef, editQueuedMessage } = useMobileNativeChatQueuedEditFocus(
    queuedMessages.onEdit
  )
  const { cards, onSend, onDelete, pause, onResume } = queuedMessages
  return useMemo(
    () => ({
      cards: createElement(MobileNativeChatQueuedMessages, {
        cards,
        onSend,
        onDelete,
        onEdit: editQueuedMessage,
        pause,
        onResume
      }),
      composerInputRef
    }),
    [cards, composerInputRef, editQueuedMessage, onDelete, onResume, onSend, pause]
  )
}
