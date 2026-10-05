import { useReducer } from 'react'
import {
  NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT,
  type NativeChatAsyncQuestionsField,
  type NativeChatAsyncQuestionsView
} from '../../../../shared/native-chat-async-questions'

type AsyncQuestionsFrame = { type: string; asyncQuestions?: NativeChatAsyncQuestionsField }

/** A hydrating frame states the whole set (absent = old host); an append only a change. */
function reduceAsyncQuestionsView(
  previous: NativeChatAsyncQuestionsView,
  frame: AsyncQuestionsFrame | null
): NativeChatAsyncQuestionsView {
  if (!frame) {
    return NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT
  }
  if (frame.type === 'appended') {
    return frame.asyncQuestions ?? previous
  }
  return frame.asyncQuestions ?? NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT
}

/** The host-derived async questions a terminal transcript stream publishes. */
export function useNativeChatAsyncQuestionsView(): readonly [
  NativeChatAsyncQuestionsView,
  (frame: AsyncQuestionsFrame | null) => void
] {
  return useReducer(reduceAsyncQuestionsView, NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT)
}
