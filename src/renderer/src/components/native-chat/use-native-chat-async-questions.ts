import { useCallback, useRef, useState } from 'react'
import {
  buildNativeChatAsyncQuestionReply,
  nativeChatAsyncAnswerDelivered,
  nativeChatAsyncQuestionsOpen,
  nativeChatAsyncQuestionsSendable,
  pruneNativeChatAsyncQuestionKeys,
  type NativeChatAsyncAnswerOutcome,
  type NativeChatAsyncQuestionEdit,
  type NativeChatAsyncQuestionEdits
} from '../../../../shared/native-chat-async-question-answers'
import {
  nativeChatAsyncQuestionsShown,
  type NativeChatAsyncQuestion,
  type NativeChatAsyncQuestionsView
} from '../../../../shared/native-chat-async-questions'

/** Delivers one formatted answer through the pane's ordinary message seam, settled honestly. */
export type NativeChatAsyncAnswerSend = (
  text: string,
  answers: Record<string, string>
) => Promise<NativeChatAsyncAnswerOutcome>

type CardState = {
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  edits: NativeChatAsyncQuestionEdits
  dismissed: Readonly<Record<string, true>>
  sending: boolean
}

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
  const [state, setState] = useState<CardState>(() => ({
    scopeKey,
    view,
    edits: {},
    dismissed: {},
    sending: false
  }))
  // Render-time adjustment (react.dev): a new scope starts clean; a new authoritative set
  // retires the state of questions it no longer lists.
  if (state.scopeKey !== scopeKey) {
    setState({ scopeKey, view, edits: {}, dismissed: {}, sending: false })
  } else if (state.view !== view) {
    setState({
      ...state,
      view,
      edits: pruneNativeChatAsyncQuestionKeys(view, state.edits),
      dismissed: pruneNativeChatAsyncQuestionKeys(view, state.dismissed)
    })
  }
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey

  const open = nativeChatAsyncQuestionsOpen(
    nativeChatAsyncQuestionsShown(view),
    new Set(Object.keys(state.dismissed))
  )
  const canSend = !state.sending && nativeChatAsyncQuestionsSendable(open, state.edits)

  const edit = useCallback((key: string, next: NativeChatAsyncQuestionEdit) => {
    setState((current) => ({ ...current, edits: { ...current.edits, [key]: next } }))
  }, [])
  const dismiss = useCallback((key: string) => {
    setState((current) => ({ ...current, dismissed: { ...current.dismissed, [key]: true } }))
  }, [])
  const submit = (): void => {
    const reply = canSend ? buildNativeChatAsyncQuestionReply(open, state.edits) : null
    if (!reply) {
      return
    }
    const sentScope = scopeKey
    setState((current) => ({ ...current, sending: true }))
    const settle = (outcome: NativeChatAsyncAnswerOutcome): void => {
      if (scopeRef.current !== sentScope) {
        return
      }
      setState((current) => {
        if (!nativeChatAsyncAnswerDelivered(outcome)) {
          return { ...current, sending: false }
        }
        const edits = { ...current.edits }
        for (const key of Object.keys(reply.answers)) {
          delete edits[key]
        }
        return { ...current, sending: false, edits }
      })
    }
    void send(reply.text, reply.answers).then(settle, () => settle('unknown'))
  }

  return {
    open,
    omittedCount: view.state === 'ready' ? (view.omittedCount ?? 0) : 0,
    edits: state.edits,
    sending: state.sending,
    canSend,
    edit,
    dismiss,
    submit
  }
}
