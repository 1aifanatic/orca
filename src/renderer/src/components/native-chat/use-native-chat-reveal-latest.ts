// How a chat pane tells its transcript that the reader just sent something.

import { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import { hasAskAnswer } from './native-chat-interactive-prompt'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

export function useNativeChatInteractiveSendReveal(
  { sendAnswer, sendRaw, cancelPending, cancelAsk, cancel }: NativeChatInteractiveSend,
  targetPtyId: string | null,
  revealLatest: () => void
): NativeChatInteractiveSend {
  return useMemo<NativeChatInteractiveSend>(
    () => ({
      // Only what is written moves the reader: no terminal, or an empty answer, writes nothing.
      sendAnswer: (prompt, selections, onDeliverySettled) => {
        if (targetPtyId && hasAskAnswer(prompt, selections)) {
          revealLatest()
        }
        return sendAnswer(prompt, selections, onDeliverySettled)
      },
      sendRaw: (raw) => {
        if (targetPtyId) {
          revealLatest()
        }
        sendRaw(raw)
      },
      cancelPending,
      cancelAsk,
      cancel
    }),
    [cancel, cancelAsk, cancelPending, revealLatest, sendAnswer, sendRaw, targetPtyId]
  )
}

export type NativeChatMessageListHandle = {
  /** Bring the latest into view and follow it, wherever the reader had scrolled. */
  revealLatest: () => void
  /** For a send whose outcome arrives later: a reveal that lapses if the reader acts first. */
  holdRevealLatest: () => () => void
}

export function useNativeChatRevealLatest(
  scopeKey = '',
  isVisible = true
): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  revealLatest: () => void
  holdRevealLatest: () => () => void
} {
  const messageListRef = useRef<NativeChatMessageListHandle>(null)
  const generationRef = useRef(0)
  const previousScopeRef = useRef(scopeKey)
  const visibleRef = useRef(isVisible)
  useLayoutEffect(() => {
    if (previousScopeRef.current !== scopeKey || !isVisible) {
      generationRef.current += 1
    }
    previousScopeRef.current = scopeKey
    visibleRef.current = isVisible
    return () => {
      generationRef.current += 1
    }
  }, [isVisible, scopeKey])
  const revealLatest = useCallback(() => {
    try {
      messageListRef.current?.revealLatest()
    } catch (error) {
      console.error('Could not reveal the submitted chat content', error)
    }
  }, [])
  const holdRevealLatest = useCallback(() => {
    const origin = messageListRef.current
    let reveal: (() => void) | undefined
    try {
      reveal = origin?.holdRevealLatest()
    } catch (error) {
      console.error('Could not prepare chat navigation', error)
    }
    const generation = generationRef.current
    return () => {
      if (visibleRef.current && generationRef.current === generation) {
        try {
          reveal?.()
        } catch (error) {
          console.error('Could not reveal the submitted chat content', error)
        }
      }
    }
  }, [])
  return { messageListRef, revealLatest, holdRevealLatest }
}

/** The transcript's side: what a pane's reveal does to this list. */
export function useNativeChatMessageListHandle(
  ref: React.Ref<NativeChatMessageListHandle> | undefined,
  revealLatest: () => void,
  untilReaderActs: (act: () => void) => () => void
): void {
  useImperativeHandle(
    ref,
    () => ({ revealLatest, holdRevealLatest: () => untilReaderActs(revealLatest) }),
    [revealLatest, untilReaderActs]
  )
}
