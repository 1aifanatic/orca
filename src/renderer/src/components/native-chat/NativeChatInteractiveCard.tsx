import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  NATIVE_CHAT_APPROVAL_DENY_SEND,
  type InteractivePromptCard
} from './native-chat-interactive-prompt'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

/**
 * Render one prompt occurrence the view chose (see useNativeChatPromptCardPresentation): a
 * question wizard or a tool approval, in the composer's place. Sends through the composer's
 * verified runtime path (R8/R6): answers via agent-specific paste or selector keystrokes;
 * cancel/deny as ESC. The view keys this per occurrence and unmounts it when send authority is
 * lost, so a replacement prompt, ownership loss or unmount stops every pending write.
 *
 * The card hides (`onDismiss`) only once its answer was delivered: a refused or unconfirmed
 * answer keeps the choices up, so the user can answer again here or in the terminal.
 */
export function NativeChatInteractiveCard({
  card,
  send,
  onDismiss,
  shouldFocus = false,
  answerInputRef
}: {
  card: NonNullable<InteractivePromptCard>
  send: NativeChatInteractiveSend
  /** Hide this occurrence; its answer reached the agent. */
  onDismiss: () => void
  /** Move focus to an approval card, which has no text input of its own. */
  shouldFocus?: boolean
  /** Forwarded to the question card's free-text row so pane-level Paste keeps
   *  a target while the composer is unmounted. */
  answerInputRef?: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const { sendAnswer, sendRawVerified, cancelPending, cancelAsk } = send
  // A question answer is a paced multi-step write (body→Enter per question); keep
  // the card up until it settles instead of dismissing on the click, so it doesn't
  // vanish mid-send. `submitting` also gates a second submit racing the first.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const settle = useCallback((): void => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    submittingRef.current = false
    setSubmitting(false)
  }, [])
  // Why layout: stop timers and PTY writes during commit, before an old answer can type into
  // whatever replaces this occurrence.
  useLayoutEffect(
    () => () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
      }
      cancelPending()
    },
    [cancelPending]
  )

  if (card.kind === 'question') {
    return (
      <NativeChatQuestionCard
        prompt={card.prompt}
        isSubmitting={submitting}
        answerInputRef={answerInputRef}
        onAnswer={(selections) => {
          if (submittingRef.current) {
            return
          }
          submittingRef.current = true
          const result = sendAnswer(card.prompt, selections, (delivered) => {
            settle()
            if (delivered) {
              onDismiss()
            }
          })
          if (result.settleAfterMs <= 0) {
            // Keep the actionable card visible when its PTY disappeared between
            // render and submit; the next live target update can make it retryable.
            settle()
            return
          }
          setSubmitting(true)
          if (result.waitsForVerifiedDelivery) {
            // Why: remote acceptance can outlive the keystroke pacing window.
            // Keep the card until delivery is proven instead of cancelling the
            // inference callback at the old fixed dismissal deadline.
            return
          }
          // Hold the card until the paced write finishes, then mark it answered
          // (which hides it and restores the composer).
          dismissTimerRef.current = setTimeout(() => {
            cancelPending()
            settle()
            onDismiss()
          }, result.settleAfterMs)
        }}
        onCancel={() => {
          settle()
          submittingRef.current = true
          setSubmitting(true)
          void cancelAsk().then((delivered) => {
            settle()
            if (delivered) {
              onDismiss()
            }
          })
        }}
      />
    )
  }
  const choose = (raw: string): void => {
    if (submittingRef.current) {
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    void sendRawVerified(raw).then((delivered) => {
      settle()
      if (delivered) {
        onDismiss()
      }
    })
  }
  const deny = card.approval.options.find(
    (option) => option.send === NATIVE_CHAT_APPROVAL_DENY_SEND
  )
  return (
    <NativeChatApprovalCard
      approval={card.approval}
      shouldFocus={shouldFocus}
      isSubmitting={submitting}
      onChoose={choose}
      {...(deny ? { onEscape: () => choose(deny.send) } : {})}
    />
  )
}
