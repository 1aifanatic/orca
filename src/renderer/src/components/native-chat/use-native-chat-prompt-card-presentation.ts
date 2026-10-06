import { useCallback, useState } from 'react'
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
 * never says the agent moved on. The live status lingers after an answer (the post-tool event
 * carries the same prompt), which is why an answered occurrence stays hidden.
 */
export function useNativeChatPromptCardPresentation({
  paneKey,
  card,
  canSend
}: {
  paneKey: string
  card: InteractivePromptCard
  /** False while a phone holds this PTY: no card answers from here, and the composer shows why. */
  canSend: boolean
}): NativeChatPromptCardPresentation {
  // Why the wait's start for approvals: two approvals with the same text are separate prompts.
  const approvalStartedAt = useAppStore((s) =>
    card?.kind === 'approval' ? (s.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null) : null
  )
  const contentKey = nativeChatCardDismissKey(card)
  const occurrenceKey =
    contentKey === null || approvalStartedAt === null
      ? contentKey
      : `${contentKey}@${approvalStartedAt}`
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  // Why reset when the prompt clears: a later, identical question must show again.
  const present = card !== null
  const [wasPresent, setWasPresent] = useState(present)
  if (present !== wasPresent) {
    setWasPresent(present)
    if (!present) {
      setDismissedKey(null)
    }
  }
  const dismiss = useCallback(() => setDismissedKey(occurrenceKey), [occurrenceKey])
  const shown = card !== null && canSend && occurrenceKey !== dismissedKey
  return { card: shown ? card : null, occurrenceKey, dismiss }
}
