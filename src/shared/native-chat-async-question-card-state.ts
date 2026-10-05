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
export type NativeChatAsyncQuestionCardScope = {
  edits: NativeChatAsyncQuestionEdits
  dismissed: Readonly<Record<string, true>>
  sending: boolean
}
type ScopeState = NativeChatAsyncQuestionCardScope

/** Answers a transport already holds durably, by question key: still on their way
 *  (`sendingKeys`) or back after a delivery that didn't happen. Re-derived each render from
 *  that transport's own records, so the card neither stores nor latches them. */
export type NativeChatAsyncAnswerProgress = {
  answers: Readonly<Record<string, string>>
  sendingKeys: ReadonlySet<string>
}

export type NativeChatAsyncQuestionCardState = ScopeState & {
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  /** Other conversations' state, newest last, so switching back restores it. */
  parked: Readonly<Record<string, ScopeState>>
}

/** What changes one conversation's card. */
export type NativeChatAsyncQuestionScopeAction =
  | { type: 'edit'; key: string; edit: NativeChatAsyncQuestionEdit }
  | { type: 'dismiss'; key: string }
  | { type: 'sending' }
  | {
      type: 'settled'
      scopeKey: string
      outcome: NativeChatAsyncAnswerOutcome
      /** The edits the send carried, given back unless it was delivered. */
      sent: Readonly<Record<string, NativeChatAsyncQuestionEdit>>
    }

export type NativeChatAsyncQuestionCardAction =
  | { type: 'observe'; scopeKey: string; view: NativeChatAsyncQuestionsView }
  | NativeChatAsyncQuestionScopeAction

const MAX_PARKED_SCOPES = 16
export const EMPTY_NATIVE_CHAT_ASYNC_QUESTION_CARD_SCOPE: ScopeState = {
  edits: {},
  dismissed: {},
  sending: false
}
const EMPTY_SCOPE = EMPTY_NATIVE_CHAT_ASYNC_QUESTION_CARD_SCOPE

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
  if (!nativeChatAsyncAnswerDelivered(action.outcome)) {
    return { ...scope, sending: false, edits: { ...action.sent, ...scope.edits } }
  }
  const edits = { ...scope.edits }
  for (const key of Object.keys(action.sent)) {
    delete edits[key]
  }
  return { ...scope, sending: false, edits }
}

export function reduceNativeChatAsyncQuestionScope(
  scope: ScopeState,
  action: NativeChatAsyncQuestionScopeAction
): ScopeState {
  switch (action.type) {
    case 'edit':
      return { ...scope, edits: { ...scope.edits, [action.key]: action.edit } }
    case 'dismiss':
      return { ...scope, dismissed: { ...scope.dismissed, [action.key]: true } }
    case 'sending':
      return { ...scope, sending: true }
    case 'settled':
      return settle(scope, action)
  }
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
    case 'dismiss':
    case 'sending':
      return { ...state, ...reduceNativeChatAsyncQuestionScope(scopeOf(state), action) }
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
  /** What each question shows: the user's edit, else an answer the transport still holds. */
  edits: NativeChatAsyncQuestionEdits
  sending: boolean
  canSend: boolean
}

export function nativeChatAsyncQuestionScopeView(
  scope: ScopeState,
  view: NativeChatAsyncQuestionsView,
  progress?: NativeChatAsyncAnswerProgress
): NativeChatAsyncQuestionCardView {
  const open = nativeChatAsyncQuestionsOpen(
    nativeChatAsyncQuestionsShown(view),
    new Set(Object.keys(scope.dismissed))
  )
  const edits = progress
    ? { ...nativeChatAsyncQuestionEditsFromAnswers(open, progress.answers), ...scope.edits }
    : scope.edits
  const sending =
    scope.sending || open.some((question) => progress?.sendingKeys.has(question.key) === true)
  return {
    open,
    omittedCount: view.state === 'ready' ? (view.omittedCount ?? 0) : 0,
    edits,
    sending,
    canSend: !sending && nativeChatAsyncQuestionsSendable(open, edits)
  }
}

export function nativeChatAsyncQuestionCardView(
  state: NativeChatAsyncQuestionCardState
): NativeChatAsyncQuestionCardView {
  return nativeChatAsyncQuestionScopeView(scopeOf(state), state.view)
}

/** Sends the card's answers through `send` and settles the card on its honest outcome. */
export function submitNativeChatAsyncQuestionScope(
  card: Pick<NativeChatAsyncQuestionCardView, 'open' | 'edits' | 'canSend'> & {
    scopeKey: string
  },
  dispatch: (action: NativeChatAsyncQuestionScopeAction) => void,
  send: (text: string, answers: Record<string, string>) => Promise<NativeChatAsyncAnswerOutcome>
): void {
  const reply = card.canSend ? buildNativeChatAsyncQuestionReply(card.open, card.edits) : null
  if (!reply) {
    return
  }
  dispatch({ type: 'sending' })
  const sent = nativeChatAsyncQuestionEditsFromAnswers(card.open, reply.answers)
  const { scopeKey } = card
  const settled = (outcome: NativeChatAsyncAnswerOutcome): void =>
    dispatch({ type: 'settled', scopeKey, outcome, sent })
  void send(reply.text, reply.answers).then(settled, () => settled('unknown'))
}

export function submitNativeChatAsyncQuestionCard(
  state: NativeChatAsyncQuestionCardState,
  dispatch: (action: NativeChatAsyncQuestionCardAction) => void,
  send: (text: string, answers: Record<string, string>) => Promise<NativeChatAsyncAnswerOutcome>
): void {
  submitNativeChatAsyncQuestionScope(
    { scopeKey: state.scopeKey, ...nativeChatAsyncQuestionCardView(state) },
    dispatch,
    send
  )
}
