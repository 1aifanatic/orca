// The async question card's per-question state as one pure reducer, so desktop and phone
// keep identical rules: keyed by question, pruned only by an authoritative set, Send blocked
// only while one is in flight, and sent edits cleared only by a delivered outcome.

import {
  buildNativeChatAsyncQuestionReply,
  nativeChatAsyncAnswerDelivered,
  nativeChatAsyncQuestionEditsFromAnswers,
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

/** One conversation's card state, kept while the user is in another conversation. */
type ScopeState = {
  edits: NativeChatAsyncQuestionEdits
  dismissed: Readonly<Record<string, true>>
  sending: boolean
}

export type NativeChatAsyncQuestionCardState = ScopeState & {
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  /** Other conversations' state, newest last, so switching back restores it. */
  parked: Readonly<Record<string, ScopeState>>
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
      /** The edits the send carried, restored if it was taken back before dispatch. */
      sent: Readonly<Record<string, NativeChatAsyncQuestionEdit>>
    }

const MAX_PARKED_SCOPES = 16
const EMPTY_SCOPE: ScopeState = { edits: {}, dismissed: {}, sending: false }

export function createNativeChatAsyncQuestionCardState(
  scopeKey: string,
  view: NativeChatAsyncQuestionsView
): NativeChatAsyncQuestionCardState {
  return { scopeKey, view, ...EMPTY_SCOPE, parked: {} }
}

function scopeOf(state: NativeChatAsyncQuestionCardState): ScopeState {
  return { edits: state.edits, dismissed: state.dismissed, sending: state.sending }
}

function park(
  parked: Readonly<Record<string, ScopeState>>,
  scopeKey: string,
  scope: ScopeState
): Record<string, ScopeState> {
  const next: Record<string, ScopeState> = { ...parked }
  delete next[scopeKey]
  next[scopeKey] = scope
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PARKED_SCOPES))) {
    delete next[key]
  }
  return next
}

function observe(
  scope: ScopeState,
  view: NativeChatAsyncQuestionsView
): Pick<ScopeState, 'edits' | 'dismissed'> {
  return {
    edits: pruneNativeChatAsyncQuestionKeys(view, scope.edits),
    dismissed: pruneNativeChatAsyncQuestionKeys(view, scope.dismissed)
  }
}

function settle(
  scope: ScopeState,
  action: Extract<NativeChatAsyncQuestionCardAction, { type: 'settled' }>
): ScopeState {
  if (action.outcome === 'withdrawn') {
    return { ...scope, sending: false, edits: { ...action.sent, ...scope.edits } }
  }
  if (!nativeChatAsyncAnswerDelivered(action.outcome)) {
    return { ...scope, sending: false }
  }
  const edits = { ...scope.edits }
  for (const key of Object.keys(action.sent)) {
    delete edits[key]
  }
  return { ...scope, sending: false, edits }
}

export function reduceNativeChatAsyncQuestionCard(
  state: NativeChatAsyncQuestionCardState,
  action: NativeChatAsyncQuestionCardAction
): NativeChatAsyncQuestionCardState {
  switch (action.type) {
    case 'observe': {
      if (action.scopeKey !== state.scopeKey) {
        const { [action.scopeKey]: restored = EMPTY_SCOPE, ...others } = park(
          state.parked,
          state.scopeKey,
          scopeOf(state)
        )
        return {
          scopeKey: action.scopeKey,
          view: action.view,
          sending: restored.sending,
          ...observe(restored, action.view),
          parked: others
        }
      }
      return action.view === state.view
        ? state
        : { ...state, view: action.view, ...observe(state, action.view) }
    }
    case 'edit':
      return { ...state, edits: { ...state.edits, [action.key]: action.edit } }
    case 'dismiss':
      return { ...state, dismissed: { ...state.dismissed, [action.key]: true } }
    case 'sending':
      return { ...state, sending: true }
    case 'settled': {
      if (action.scopeKey === state.scopeKey) {
        return { ...state, ...settle(scopeOf(state), action) }
      }
      const parked = state.parked[action.scopeKey]
      return parked
        ? { ...state, parked: { ...state.parked, [action.scopeKey]: settle(parked, action) } }
        : state
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

/** Sends the card's answers through `send` and settles the card on its honest outcome. */
export function submitNativeChatAsyncQuestionCard(
  state: NativeChatAsyncQuestionCardState,
  dispatch: (action: NativeChatAsyncQuestionCardAction) => void,
  send: (text: string, answers: Record<string, string>) => Promise<NativeChatAsyncAnswerOutcome>
): void {
  const { open, canSend } = nativeChatAsyncQuestionCardView(state)
  const reply = canSend ? buildNativeChatAsyncQuestionReply(open, state.edits) : null
  if (!reply) {
    return
  }
  dispatch({ type: 'sending' })
  const sent = nativeChatAsyncQuestionEditsFromAnswers(open, reply.answers)
  const { scopeKey } = state
  const settled = (outcome: NativeChatAsyncAnswerOutcome): void =>
    dispatch({ type: 'settled', scopeKey, outcome, sent })
  void send(reply.text, reply.answers).then(settled, () => settled('unknown'))
}
