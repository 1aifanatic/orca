import { useCallback, useMemo } from 'react'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useMobileNativeChatPromptDismiss } from './use-mobile-native-chat-prompt-dismiss'

/** Acknowledged answers hide, and the user's Collapse folds, a terminal card without changing
 *  host status. */
export function useMobileNativeChatPromptPresentation({
  permission,
  question,
  waitStartedAt,
  scopeKey,
  sessionKey,
  observing,
  respondPermission,
  answerQuestion
}: {
  permission: MobileChatPermission | null
  question: MobileChatQuestion | null
  /** The host wait's start: identical prompts in separate waits are separate occurrences. */
  waitStartedAt: number | null
  scopeKey: string | null
  sessionKey: string | null
  observing: boolean
  respondPermission: (send: string) => Promise<boolean>
  answerQuestion: (text: string) => Promise<boolean>
}) {
  const promptKey = useMemo(
    () =>
      permission
        ? JSON.stringify(['approval', permission, waitStartedAt])
        : question
          ? JSON.stringify(['question', question, waitStartedAt])
          : null,
    [permission, question, waitStartedAt]
  )
  const { showPrompt, collapsed, dismissPrompt, collapsePrompt, expandPrompt } =
    useMobileNativeChatPromptDismiss({
      kind: 'prompt',
      promptKey,
      detectedPromptKey: promptKey,
      scopeKey,
      sessionKey,
      observing
    })
  const respond = useCallback(
    async (send: string): Promise<boolean> => {
      const accepted = await respondPermission(send)
      if (accepted) {
        dismissPrompt()
      }
      return accepted
    },
    [respondPermission, dismissPrompt]
  )
  const answer = useCallback(
    async (text: string): Promise<boolean> => {
      const accepted = await answerQuestion(text)
      if (accepted) {
        dismissPrompt()
      }
      return accepted
    },
    [answerQuestion, dismissPrompt]
  )
  return {
    occurrenceKey: promptKey === null ? null : JSON.stringify([scopeKey, sessionKey, promptKey]),
    permission: showPrompt ? permission : null,
    question: showPrompt ? question : null,
    collapsePrompt,
    collapsed:
      collapsed && (permission ?? question)
        ? { title: permission?.title ?? question?.question ?? '', expand: expandPrompt }
        : null,
    respondPermission: respond,
    answerQuestion: answer
  }
}

/** Select the lane's existing card actions and apply terminal-only presentation dismissal. */
export function useMobileNativeChatPromptCards({
  terminal,
  structured,
  onSendResolved
}: {
  terminal: Parameters<typeof useMobileNativeChatPromptPresentation>[0]
  structured: Pick<
    ReturnType<typeof useMobileStructuredAgentSession>,
    'permission' | 'question' | 'respondPermission' | 'respondQuestion' | 'cancelPrompt'
  > | null
  onSendResolved: () => void
}): Pick<
  MobileNativeChatController,
  | 'nativeChatPermission'
  | 'nativeChatQuestion'
  | 'nativeChatPromptKey'
  | 'handleNativeChatRespondPermission'
  | 'handleNativeChatQuestionAnswer'
  | 'handleNativeChatCancelPrompt'
  | 'collapseNativeChatPrompt'
  | 'nativeChatCollapsedPrompt'
> {
  const respond = useNativeChatAcceptedAction(
    structured?.respondPermission ?? terminal.respondPermission,
    onSendResolved
  )
  const cancel = useNativeChatAcceptedAction(
    structured?.cancelPrompt ?? (async () => false),
    onSendResolved
  )
  const presentation = useMobileNativeChatPromptPresentation({
    ...terminal,
    respondPermission: respond
  })
  return {
    nativeChatPermission: structured ? structured.permission : presentation.permission,
    nativeChatQuestion: structured ? structured.question : presentation.question,
    nativeChatPromptKey: structured ? null : presentation.occurrenceKey,
    handleNativeChatRespondPermission: structured ? respond : presentation.respondPermission,
    handleNativeChatQuestionAnswer: structured
      ? structured.respondQuestion
      : presentation.answerQuestion,
    handleNativeChatCancelPrompt: structured ? cancel : undefined,
    collapseNativeChatPrompt: structured ? undefined : presentation.collapsePrompt,
    nativeChatCollapsedPrompt: structured ? null : presentation.collapsed
  }
}
