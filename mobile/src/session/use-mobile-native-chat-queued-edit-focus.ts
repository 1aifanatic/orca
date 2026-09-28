import { useMemo, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'

type QueuedEdit = (messageId: string) => Promise<boolean>

/** Wraps a queued card's Edit so the composer it fills takes focus, and typing continues
 *  without another tap. */
export function useMobileNativeChatQueuedEditFocus(onEdit: QueuedEdit | undefined): {
  composerInputRef: RefObject<TextInput | null>
  editQueuedMessage: QueuedEdit | undefined
} {
  const composerInputRef = useRef<TextInput>(null)
  const editQueuedMessage = useMemo<QueuedEdit | undefined>(
    () =>
      onEdit
        ? (messageId) => {
            const edited = onEdit(messageId)
            // Next frame, so the copied text has landed in the field before it takes focus.
            requestAnimationFrame(() => composerInputRef.current?.focus())
            return edited
          }
        : undefined,
    [onEdit]
  )
  return { composerInputRef, editQueuedMessage }
}
