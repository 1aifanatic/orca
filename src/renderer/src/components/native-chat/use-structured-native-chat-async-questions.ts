import { NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT } from '../../../../shared/native-chat-async-questions'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import {
  useNativeChatAsyncQuestions,
  type NativeChatAsyncQuestionsCardModel
} from './use-native-chat-async-questions'
import { useStructuredAsyncAnswerSend } from './use-structured-async-answer-send'

/** The structured pane's async question card, answered through the outbox. */
export function useStructuredNativeChatAsyncQuestions(
  paneKey: string,
  sessionId: string,
  controller: ReturnType<typeof useStructuredAgentSession>
): NativeChatAsyncQuestionsCardModel {
  const send = useStructuredAsyncAnswerSend({
    sessionId,
    sendAsyncAnswer: controller.sendAsyncAnswer,
    outbox: controller.outbox,
    submissions: controller.submissions,
    queuedMessageIds: controller.queuedMessageIds
  })
  return useNativeChatAsyncQuestions({
    scopeKey: paneKey,
    // Absent until the transport has a host answer.
    view: controller.asyncQuestions ?? NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT,
    send
  })
}
