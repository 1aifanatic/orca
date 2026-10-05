import { useCallback, useReducer } from 'react'
import {
  buildNativeChatAsyncQuestionReply,
  type NativeChatAsyncAnswerOutcome,
  type NativeChatAsyncQuestionEdit,
  type NativeChatAsyncQuestionEdits
} from '../../../src/shared/native-chat-async-question-answers'
import {
  createNativeChatAsyncQuestionCardState,
  nativeChatAsyncQuestionCardView,
  reduceNativeChatAsyncQuestionCard
} from '../../../src/shared/native-chat-async-question-card-state'
import type {
  NativeChatAsyncQuestion,
  NativeChatAsyncQuestionsView
} from '../../../src/shared/native-chat-async-questions'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'

export type MobileNativeChatAsyncQuestionsModel = {
  open: NativeChatAsyncQuestion[]
  omittedCount: number
  edits: NativeChatAsyncQuestionEdits
  sending: boolean
  canSend: boolean
  edit: (key: string, edit: NativeChatAsyncQuestionEdit) => void
  dismiss: (key: string) => void
  submit: () => void
}

/**
 * Controller-owned async question card state (it survives the chat↔terminal toggle), keyed
 * by question. Send goes through the active lane's answer seam — the terminal write lock or
 * the structured bridge — and never touches the composer draft.
 */
export function useMobileNativeChatAsyncQuestions(args: {
  /** Session tab + chat session: edits never carry over to another conversation. */
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  structured: boolean
  answerTerminal: (text: string) => Promise<MobileNativeChatSendOutcome>
  answerStructured: (text: string) => Promise<MobileNativeChatSendOutcome>
}): MobileNativeChatAsyncQuestionsModel {
  const { scopeKey, view, structured, answerTerminal, answerStructured } = args
  const [state, dispatch] = useReducer(
    reduceNativeChatAsyncQuestionCard,
    createNativeChatAsyncQuestionCardState(scopeKey, view)
  )
  // Render-time adjustment: a new scope starts clean; an authoritative set prunes.
  if (state.scopeKey !== scopeKey || state.view !== view) {
    dispatch({ type: 'observe', scopeKey, view })
  }
  const { open, omittedCount, canSend } = nativeChatAsyncQuestionCardView(state)
  const edit = useCallback(
    (key: string, next: NativeChatAsyncQuestionEdit) => dispatch({ type: 'edit', key, edit: next }),
    []
  )
  const dismiss = useCallback((key: string) => dispatch({ type: 'dismiss', key }), [])
  const submit = (): void => {
    const reply = canSend ? buildNativeChatAsyncQuestionReply(open, state.edits) : null
    if (!reply) {
      return
    }
    dispatch({ type: 'sending' })
    const answeredKeys = Object.keys(reply.answers)
    const settle = (outcome: NativeChatAsyncAnswerOutcome): void =>
      dispatch({ type: 'settled', scopeKey, outcome, answeredKeys })
    const answer = structured ? answerStructured : answerTerminal
    void answer(reply.text).then(settle, () => settle('unknown'))
  }
  return {
    open,
    omittedCount,
    edits: state.edits,
    sending: state.sending,
    canSend,
    edit,
    dismiss,
    submit
  }
}
