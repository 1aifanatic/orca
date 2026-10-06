import { useCallback, useMemo } from 'react'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useMobileNativeChatPromptDismiss } from './use-mobile-native-chat-prompt-dismiss'

/** Acknowledged terminal answers hide their card without changing the host's status. */
export function useMobileNativeChatPromptPresentation({
  permission,
  question,
  approvalStartedAt,
  scopeKey,
  sessionKey,
  observing,
  respondPermission,
  answerQuestion
}: {
  permission: MobileChatPermission | null
  question: MobileChatQuestion | null
  approvalStartedAt: number | null
  scopeKey: string | null
  sessionKey: string | null
  observing: boolean
  respondPermission: (send: string) => Promise<boolean>
  answerQuestion: (text: string) => Promise<boolean>
}) {
  const promptKey = useMemo(
    () =>
      permission
        ? JSON.stringify(['approval', permission, approvalStartedAt])
        : question
          ? JSON.stringify(['question', question])
          : null,
    [permission, question, approvalStartedAt]
  )
  const { showPrompt, dismissPrompt } = useMobileNativeChatPromptDismiss({
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
    handleNativeChatCancelPrompt: structured ? cancel : undefined
  }
}
