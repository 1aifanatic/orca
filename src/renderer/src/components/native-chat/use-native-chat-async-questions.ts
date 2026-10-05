import { useCallback, useReducer } from 'react'
import type {
  NativeChatAsyncAnswerOutcome,
  NativeChatAsyncQuestionEdit,
  NativeChatAsyncQuestionEdits
} from '../../../../shared/native-chat-async-question-answers'
import {
  createNativeChatAsyncQuestionCardState,
  nativeChatAsyncQuestionCardView,
  reduceNativeChatAsyncQuestionCard,
  submitNativeChatAsyncQuestionCard
} from '../../../../shared/native-chat-async-question-card-state'
import type {
  NativeChatAsyncQuestion,
  NativeChatAsyncQuestionsView
} from '../../../../shared/native-chat-async-questions'

/** Delivers one formatted answer through the pane's ordinary message seam, settled honestly. */
export type NativeChatAsyncAnswerSend = (
  text: string,
  answers: Record<string, string>
) => Promise<NativeChatAsyncAnswerOutcome>

export type NativeChatAsyncQuestionsCardModel = {
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
 * Per-pane state for the async question card, keyed by question so a question added
 * while another is edited, dismissed or sent changes nothing for it. The card stays
 * until the host's set drops a question; Send is only disabled while one is in flight.
 */
export function useNativeChatAsyncQuestions(args: {
  /** Pane + session: edits never carry over to another conversation. */
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  send: NativeChatAsyncAnswerSend
}): NativeChatAsyncQuestionsCardModel {
  const { scopeKey, view, send } = args
  const [state, dispatch] = useReducer(
    reduceNativeChatAsyncQuestionCard,
    createNativeChatAsyncQuestionCardState(scopeKey, view)
  )
  // Render-time adjustment (react.dev): a new scope starts clean; a new authoritative set
  // retires the state of questions it no longer lists.
  if (state.scopeKey !== scopeKey || state.view !== view) {
    dispatch({ type: 'observe', scopeKey, view })
  }
  const { open, omittedCount, canSend } = nativeChatAsyncQuestionCardView(state)

  const edit = useCallback(
    (key: string, next: NativeChatAsyncQuestionEdit) => dispatch({ type: 'edit', key, edit: next }),
    []
  )
  const dismiss = useCallback((key: string) => dispatch({ type: 'dismiss', key }), [])
  const submit = (): void => submitNativeChatAsyncQuestionCard(state, dispatch, send)

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
