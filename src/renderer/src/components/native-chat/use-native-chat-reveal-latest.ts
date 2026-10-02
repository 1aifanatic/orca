// How a chat pane tells its transcript that the reader just sent something.

import { useCallback, useRef } from 'react'

export type NativeChatMessageListHandle = {
  /** Bring the latest into view and follow it, wherever the reader had scrolled. */
  revealLatest: () => void
}

export function useNativeChatRevealLatest(): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  revealLatest: () => void
} {
  const messageListRef = useRef<NativeChatMessageListHandle>(null)
  const revealLatest = useCallback(() => messageListRef.current?.revealLatest(), [])
  return { messageListRef, revealLatest }
}
