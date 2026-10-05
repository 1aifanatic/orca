// The async question card's per-question state as one pure reducer, so desktop and phone
// keep identical rules: keyed by question, pruned only by an authoritative set, Send blocked
// only while one is in flight, and sent edits cleared only by a delivered outcome.

import {
  nativeChatAsyncAnswerDelivered,
  nativeChatAsyncQuestionsOpen,
  nativeChatAsyncQuestionsSendable,
  pruneNativeChatAsyncQuestionKeys,
  type NativeChatAsyncAnswerOutcome,
  type NativeChatAsyncQuestionEdit,
  type NativeChatAsyncQuestionEdits
} from './native-chat-async-question-answers'
import {
  nativeChatAsyncQuestionsShown,
  type NativeChatAsyncQuestion,
  type NativeChatAsyncQuestionsView
} from './native-chat-async-questions'

export type NativeChatAsyncQuestionCardState = {
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  edits: NativeChatAsyncQuestionEdits
  dismissed: Readonly<Record<string, true>>
  sending: boolean
}

export type NativeChatAsyncQuestionCardAction =
  | { type: 'observe'; scopeKey: string; view: NativeChatAsyncQuestionsView }
  | { type: 'edit'; key: string; edit: NativeChatAsyncQuestionEdit }
  | { type: 'dismiss'; key: string }
  | { type: 'sending' }
  | {
      type: 'settled'
      scopeKey: string
      outcome: NativeChatAsyncAnswerOutcome
      answeredKeys: readonly string[]
    }

export function createNativeChatAsyncQuestionCardState(
  scopeKey: string,
  view: NativeChatAsyncQuestionsView
): NativeChatAsyncQuestionCardState {
  return { scopeKey, view, edits: {}, dismissed: {}, sending: false }
}

export function reduceNativeChatAsyncQuestionCard(
  state: NativeChatAsyncQuestionCardState,
  action: NativeChatAsyncQuestionCardAction
): NativeChatAsyncQuestionCardState {
  switch (action.type) {
    case 'observe':
      if (action.scopeKey !== state.scopeKey) {
        return createNativeChatAsyncQuestionCardState(action.scopeKey, action.view)
      }
      return action.view === state.view
        ? state
        : {
            ...state,
            view: action.view,
            edits: pruneNativeChatAsyncQuestionKeys(action.view, state.edits),
            dismissed: pruneNativeChatAsyncQuestionKeys(action.view, state.dismissed)
          }
    case 'edit':
      return { ...state, edits: { ...state.edits, [action.key]: action.edit } }
    case 'dismiss':
      return { ...state, dismissed: { ...state.dismissed, [action.key]: true } }
    case 'sending':
      return { ...state, sending: true }
    case 'settled': {
      if (action.scopeKey !== state.scopeKey) {
        return state
      }
      if (!nativeChatAsyncAnswerDelivered(action.outcome)) {
        return { ...state, sending: false }
      }
      const edits = { ...state.edits }
      for (const key of action.answeredKeys) {
        delete edits[key]
      }
      return { ...state, sending: false, edits }
    }
  }
}

export type NativeChatAsyncQuestionCardView = {
  open: NativeChatAsyncQuestion[]
  omittedCount: number
  canSend: boolean
}

export function nativeChatAsyncQuestionCardView(
  state: NativeChatAsyncQuestionCardState
): NativeChatAsyncQuestionCardView {
  const open = nativeChatAsyncQuestionsOpen(
    nativeChatAsyncQuestionsShown(state.view),
    new Set(Object.keys(state.dismissed))
  )
  return {
    open,
    omittedCount: state.view.state === 'ready' ? (state.view.omittedCount ?? 0) : 0,
    canSend: !state.sending && nativeChatAsyncQuestionsSendable(open, state.edits)
  }
}
