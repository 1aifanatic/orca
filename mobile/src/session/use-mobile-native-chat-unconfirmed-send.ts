import { useCallback, useEffect, useRef } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  findLandedUnconfirmedSends,
  type UnconfirmedSend
} from './mobile-native-chat-draft-reconcile'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'

const UNCONFIRMED_SEND_DEADLINE_MS = 20_000

/** Legacy acknowledgment-loss handling; terminal Claude sends use status-based pending delivery. */
export function useMobileNativeChatUnconfirmedSend(
  draftKey: string | null,
  pendingKey: string | null,
  messages: readonly NativeChatMessage[],
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string) => void
) {
  const mountedRef = useRef(false)
  const activeDraftKeyRef = useRef(draftKey)
  activeDraftKeyRef.current = draftKey
  const activePendingKeyRef = useRef(pendingKey)
  activePendingKeyRef.current = pendingKey
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // Why: a relay drop mid-send loses only the ack in the common case — the
  // desktop already delivered the message. Hold the send instead of claiming
  // failure (which baits a duplicate): stay quiet when the transcript echo
  // lands, and surface the uncertainty if the deadline passes without one.
  // The composer was already cleared at send time, so this never touches drafts.
  const unconfirmedRef = useRef<UnconfirmedSend[]>([])
  const holdUnconfirmedSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, onUnconfirmed: () => void) => {
      if (origin.deliveryOrigin) {
        acceptSend(origin, text)
        return
      }
      if (!mountedRef.current) {
        return
      }
      const isActiveTranscript =
        activeDraftKeyRef.current === origin.draftKey &&
        (origin.pendingKey === null || activePendingKeyRef.current === origin.pendingKey)
      const entry: UnconfirmedSend = {
        draftKey: origin.draftKey,
        pendingKey: origin.pendingKey,
        text,
        normalizedText: origin.normalizedText,
        baselineTailMessageId: origin.baselineTailMessageId,
        deadline: null
      }
      // Why: the transcript event can beat the lost RPC acknowledgement.
      if (
        isActiveTranscript &&
        findLandedUnconfirmedSends(messagesRef.current, [entry]).length > 0
      ) {
        return
      }
      entry.deadline = setTimeout(() => {
        unconfirmedRef.current = unconfirmedRef.current.filter((held) => held !== entry)
        onUnconfirmed()
      }, UNCONFIRMED_SEND_DEADLINE_MS)
      unconfirmedRef.current = [...unconfirmedRef.current, entry]
    },
    [acceptSend]
  )

  useEffect(() => {
    if (!draftKey || unconfirmedRef.current.length === 0) {
      return
    }
    const relevant = unconfirmedRef.current.filter(
      (entry) =>
        entry.draftKey === draftKey &&
        (entry.pendingKey === null || entry.pendingKey === pendingKey)
    )
    const landed = findLandedUnconfirmedSends(messages, relevant)
    if (landed.length === 0) {
      return
    }
    const landedSet = new Set(landed)
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !landedSet.has(entry))
    for (const entry of landed) {
      clearTimeout(entry.deadline ?? undefined)
    }
  }, [messages, draftKey, pendingKey])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const entry of unconfirmedRef.current) {
        clearTimeout(entry.deadline ?? undefined)
      }
      unconfirmedRef.current = []
    }
  }, [])

  return holdUnconfirmedSend
}
