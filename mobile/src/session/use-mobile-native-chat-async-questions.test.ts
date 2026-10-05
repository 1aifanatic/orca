import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  NativeChatAsyncQuestion,
  NativeChatAsyncQuestionsView
} from '../../../src/shared/native-chat-async-questions'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  useMobileNativeChatAsyncQuestions,
  type MobileNativeChatAsyncQuestionsModel
} from './use-mobile-native-chat-async-questions'

const q = (key: string): NativeChatAsyncQuestion => ({ key, index: 0, title: `${key}?` })
const ready = (...questions: NativeChatAsyncQuestion[]): NativeChatAsyncQuestionsView => ({
  state: 'ready',
  questions
})

type Props = { view: NativeChatAsyncQuestionsView; structured: boolean; scopeKey: string }

describe('useMobileNativeChatAsyncQuestions', () => {
  let renderer: ReactTestRenderer | null = null
  let model: MobileNativeChatAsyncQuestionsModel | null = null
  let resolveSend: (outcome: MobileNativeChatSendOutcome) => void = () => {}
  const pending = (): Promise<MobileNativeChatSendOutcome> =>
    new Promise((resolve) => {
      resolveSend = resolve
    })
  const answerTerminal = vi.fn(pending)
  const answerStructured = vi.fn(pending)

  function Harness(props: Props): null {
    model = useMobileNativeChatAsyncQuestions({ ...props, answerTerminal, answerStructured })
    return null
  }
  const mount = (props: Props): void => {
    act(() => {
      renderer = create(createElement(Harness, props))
    })
  }
  const update = (props: Props): void => {
    act(() => renderer?.update(createElement(Harness, props)))
  }
  const settle = async (outcome: MobileNativeChatSendOutcome): Promise<void> => {
    await act(async () => {
      resolveSend(outcome)
      await Promise.resolve()
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    model = null
    vi.clearAllMocks()
  })

  it('shows a question older than any loaded page: the card reads only the host set', () => {
    mount({ view: ready(q('old')), structured: false, scopeKey: 's' })
    expect(model?.open.map((question) => question.key)).toEqual(['old'])
  })

  it('keeps A through B arriving while A is edited, dismissed and sent', async () => {
    mount({ view: ready(q('a')), structured: false, scopeKey: 's' })
    act(() => model!.edit('a', { text: 'one' }))
    update({ view: ready(q('a'), q('b')), structured: false, scopeKey: 's' })
    expect(model!.edits.a).toEqual({ text: 'one' })
    act(() => model!.dismiss('b'))
    act(() => model!.submit())
    expect(answerTerminal).toHaveBeenCalledWith('Question: a?\nAnswer: one')
    expect(model!.canSend).toBe(false)
    update({ view: ready(q('a'), q('b'), q('c')), structured: false, scopeKey: 's' })
    expect(model!.sending).toBe(true)
    await settle('accepted')
    expect(model!.edits.a).toBeUndefined()
  })

  it('routes the structured lane through its bridge, and keeps edits on rejection', async () => {
    mount({ view: ready(q('a')), structured: true, scopeKey: 's' })
    act(() => model!.edit('a', { option: 'x' }))
    act(() => model!.submit())
    expect(answerStructured).toHaveBeenCalledOnce()
    expect(answerTerminal).not.toHaveBeenCalled()
    await settle('rejected')
    expect(model!.edits.a).toEqual({ option: 'x' })
    expect(model!.canSend).toBe(true)
  })

  it('reconnect while unknown: no duplicate send, the card stays with its edits', async () => {
    mount({ view: ready(q('a')), structured: false, scopeKey: 's' })
    act(() => model!.edit('a', { text: 'one' }))
    act(() => model!.submit())
    update({ view: { state: 'pending' }, structured: false, scopeKey: 's' })
    act(() => model!.submit())
    expect(answerTerminal).toHaveBeenCalledOnce()
    await settle('unknown')
    update({ view: ready(q('a')), structured: false, scopeKey: 's' })
    expect(model!.edits.a).toEqual({ text: 'one' })
  })

  it('a queued answer whose queued message is deleted leaves the card shown and sendable', async () => {
    mount({ view: ready(q('a')), structured: true, scopeKey: 's' })
    act(() => model!.edit('a', { text: 'one' }))
    act(() => model!.submit())
    await settle('queued')
    expect(model!.open).toHaveLength(1)
    act(() => model!.edit('a', { text: 'again' }))
    expect(model!.canSend).toBe(true)
  })

  it('clears a question’s state once the host set drops it, never on pending', () => {
    mount({ view: ready(q('a')), structured: false, scopeKey: 's' })
    act(() => model!.edit('a', { text: 'one' }))
    update({ view: { state: 'pending' }, structured: false, scopeKey: 's' })
    update({ view: ready(q('a')), structured: false, scopeKey: 's' })
    expect(model!.edits.a).toEqual({ text: 'one' })
    update({ view: ready(), structured: false, scopeKey: 's' })
    expect(model!.edits.a).toBeUndefined()
  })
})
