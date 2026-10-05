import { describe, expect, it, vi } from 'vitest'
import {
  createNativeChatAsyncQuestionCardState,
  nativeChatAsyncQuestionCardView,
  reduceNativeChatAsyncQuestionCard,
  submitNativeChatAsyncQuestionCard,
  type NativeChatAsyncQuestionCardAction,
  type NativeChatAsyncQuestionCardState
} from './native-chat-async-question-card-state'
import type { NativeChatAsyncAnswerOutcome } from './native-chat-async-question-answers'
import type { NativeChatAsyncQuestionsView } from './native-chat-async-questions'

const ready = (...keys: string[]): NativeChatAsyncQuestionsView => ({
  state: 'ready',
  questions: keys.map((key, index) => ({ key, index, title: `${key}?`, options: ['Red'] }))
})

function run(
  state: NativeChatAsyncQuestionCardState,
  ...actions: NativeChatAsyncQuestionCardAction[]
): NativeChatAsyncQuestionCardState {
  return actions.reduce(reduceNativeChatAsyncQuestionCard, state)
}

async function submit(
  state: NativeChatAsyncQuestionCardState,
  outcome: NativeChatAsyncAnswerOutcome
): Promise<{ actions: NativeChatAsyncQuestionCardAction[]; text: string }> {
  const actions: NativeChatAsyncQuestionCardAction[] = []
  const send = vi.fn(async (_text: string) => outcome)
  submitNativeChatAsyncQuestionCard(state, (action) => actions.push(action), send)
  await Promise.resolve()
  await Promise.resolve()
  return { actions, text: send.mock.calls[0]?.[0] ?? '' }
}

describe('async question card state', () => {
  it('keeps each conversation’s edits and dismissals across a switch away and back', () => {
    const view = ready('a', 'b')
    const tab1 = run(
      createNativeChatAsyncQuestionCardState('tab-1', view),
      { type: 'edit', key: 'a', edit: { text: 'blue' } },
      { type: 'dismiss', key: 'b' }
    )
    const tab2 = run(tab1, { type: 'observe', scopeKey: 'tab-2', view: ready('c') })
    expect(tab2.edits).toEqual({})
    const back = run(tab2, { type: 'observe', scopeKey: 'tab-1', view })
    expect(back.edits).toEqual({ a: { text: 'blue' } })
    expect(back.dismissed).toEqual({ b: true })
  })

  it('settles a send that finishes while the user is in another conversation', async () => {
    const view = ready('a')
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', view), {
      type: 'edit',
      key: 'a',
      edit: { text: 'blue' }
    })
    const { actions } = await submit(edited, 'accepted')
    const [sending, settled] = actions
    if (!sending || !settled) {
      throw new Error('expected sending and settled actions')
    }
    const away = run(edited, sending, { type: 'observe', scopeKey: 'tab-2', view: ready() })
    const back = run(away, settled, { type: 'observe', scopeKey: 'tab-1', view })
    expect(back.sending).toBe(false)
    expect(back.edits).toEqual({})
  })

  it('keeps Send disabled after switching back while the answer is still in flight', async () => {
    const view = ready('a')
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', view), {
      type: 'edit',
      key: 'a',
      edit: { option: 'Red' }
    })
    const { actions } = await submit(edited, 'accepted')
    const back = run(
      edited,
      actions[0]!,
      { type: 'observe', scopeKey: 'tab-2', view: ready() },
      { type: 'observe', scopeKey: 'tab-1', view }
    )
    expect(nativeChatAsyncQuestionCardView(back).canSend).toBe(false)
  })

  it('restores the sent answers when the send is withdrawn before dispatch', async () => {
    const view = ready('a')
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', view), {
      type: 'edit',
      key: 'a',
      edit: { option: 'Red' }
    })
    const { actions, text } = await submit(edited, 'withdrawn')
    expect(text).toBe('Question: a?\nAnswer: Red')
    const inFlight = run(edited, actions[0]!)
    const restored = run({ ...inFlight, edits: {} }, actions[1]!)
    expect(restored.sending).toBe(false)
    expect(restored.edits).toEqual({ a: { option: 'Red' } })
  })

  it('keeps edits on rejected and unknown, clears them on queued', async () => {
    const view = ready('a')
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', view), {
      type: 'edit',
      key: 'a',
      edit: { text: 'blue' }
    })
    for (const outcome of ['rejected', 'unknown'] as const) {
      const { actions } = await submit(edited, outcome)
      expect(run(edited, ...actions).edits).toEqual({ a: { text: 'blue' } })
    }
    const { actions } = await submit(edited, 'queued')
    expect(run(edited, ...actions).edits).toEqual({})
  })

  it('prunes per-key state only on an authoritative set', () => {
    const edited = run(createNativeChatAsyncQuestionCardState('tab-1', ready('a')), {
      type: 'edit',
      key: 'a',
      edit: { text: 'blue' }
    })
    const pending = run(edited, { type: 'observe', scopeKey: 'tab-1', view: { state: 'pending' } })
    expect(pending.edits).toEqual({ a: { text: 'blue' } })
    expect(run(pending, { type: 'observe', scopeKey: 'tab-1', view: ready() }).edits).toEqual({})
  })
})
