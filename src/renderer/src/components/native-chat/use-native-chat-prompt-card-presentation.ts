import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { nativeChatCardDismissKey } from './native-chat-dismiss-key'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'

export type NativeChatPromptCardPresentation = {
  /** The card that owns the input region now; null leaves it to the composer. */
  card: InteractivePromptCard
  /** Identifies this prompt occurrence; a new one remounts the card with fresh state. */
  occurrenceKey: string | null
  /** Hide this occurrence once its answer was delivered. */
  dismiss: () => void
}

/**
 * Which prompt card the pane shows, derived in render so the card and the composer never share a
 * commit. Dismissal is presentation only: it hides one occurrence after its answer was delivered and
 * never says the agent moved on. A lingering live status must not reshow an answered occurrence.
 */
export function useNativeChatPromptCardPresentation({
  paneKey,
  targetPtyId = null,
  card,
  canSend
}: {
  paneKey: string
  targetPtyId?: string | null
  card: InteractivePromptCard
  /** False while a phone holds this PTY: no card answers from here, and the composer shows why. */
  canSend: boolean
}): NativeChatPromptCardPresentation {
  // Why the wait's start for approvals: two approvals with the same text are separate prompts.
  const approvalStartedAt = useAppStore((s) =>
    card?.kind === 'approval' ? (s.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null) : null
  )
  const contentKey = nativeChatCardDismissKey(card)
  const promptKey =
    contentKey === null || approvalStartedAt === null
      ? contentKey
      : `${contentKey}@${approvalStartedAt}`
  const scopeKey = JSON.stringify([paneKey, targetPtyId])
  const occurrenceKey = promptKey === null ? null : `${scopeKey}:${promptKey}`
  const occurrence = useMemo(() => ({ occurrenceKey, canSend }), [occurrenceKey, canSend])
  const activeOccurrenceRef = useRef<object | null>(null)
  useLayoutEffect(() => {
    activeOccurrenceRef.current = occurrence
    return () => {
      activeOccurrenceRef.current = null
    }
  }, [occurrence])
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [previousScopeKey, setPreviousScopeKey] = useState(scopeKey)
  if (previousScopeKey !== scopeKey) {
    setPreviousScopeKey(scopeKey)
    setDismissedKey(null)
  }
  // Why reset when the prompt clears: a later, identical question must show again.
  const present = card !== null
  const [wasPresent, setWasPresent] = useState(present)
  if (present !== wasPresent) {
    setWasPresent(present)
    if (!present) {
      setDismissedKey(null)
    }
  }
  const dismiss = useCallback(() => {
    if (activeOccurrenceRef.current === occurrence && canSend) {
      setDismissedKey(occurrenceKey)
    }
  }, [occurrence, occurrenceKey, canSend])
  const shown = card !== null && canSend && occurrenceKey !== dismissedKey
  return { card: shown ? card : null, occurrenceKey, dismiss }
}
