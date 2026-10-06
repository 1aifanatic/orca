// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'
import {
  clearAnsweredNativeChatPromptsForTests,
  forgetAnsweredNativeChatPromptsForTab
} from './native-chat-answered-prompts'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'

const question: InteractivePromptCard = {
  kind: 'question',
  prompt: {
    questions: [{ question: 'Which folder?', multiSelect: false, options: [{ label: 'build' }] }]
  }
}

function renderPresentation(card: InteractivePromptCard = question) {
  return renderHook(
    (props: { card: InteractivePromptCard }) =>
      useNativeChatPromptCardPresentation({
        paneKey: 'tab-1:leaf-1',
        targetPtyId: 'pty-1',
        card: props.card,
        canSend: true
      }),
    { initialProps: { card } }
  )
}

beforeEach(() => {
  clearAnsweredNativeChatPromptsForTests()
})

describe('answered prompt occurrences outlive the view but not the prompt', () => {
  it('keeps an answered question hidden for a remounted view', () => {
    const first = renderPresentation()
    act(() => first.result.current.dismiss())
    expect(first.result.current.card).toBeNull()
    first.unmount()

    expect(renderPresentation().result.current.card).toBeNull()
  })

  it('shows an identical question again once the prompt cleared', () => {
    const view = renderPresentation()
    act(() => view.result.current.dismiss())
    view.rerender({ card: null })
    view.rerender({ card: question })
    expect(view.result.current.card).toBe(question)
  })

  it('forgets the answer when its tab retires', () => {
    const first = renderPresentation()
    act(() => first.result.current.dismiss())
    first.unmount()
    forgetAnsweredNativeChatPromptsForTab('tab-1')

    expect(renderPresentation().result.current.card).toBe(question)
  })
})
