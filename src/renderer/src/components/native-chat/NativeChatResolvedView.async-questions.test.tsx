// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { NativeChatAsyncQuestionsView } from '../../../../shared/native-chat-async-questions'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { clearNativeChatAsyncQuestionCardStoreForTests } from './native-chat-async-question-card-store'

// The transcript source and the composer are stubbed; the wire under test is where the
// resolved view places the async card relative to the blocking card and the composer.
const retained = vi.hoisted((): { session: NativeChatLiveSession | null } => ({ session: null }))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => retained.session
}))
vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: () => <div data-testid="composer" />
}))

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')
const { useAppStore } = await import('../../store')
const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')
const { installNativeChatMessageListTestViewport } =
  await import('./native-chat-message-list-test-viewport')

const paneKey = 'tab-async:leaf-async'
const ptyId = 'pty-async'
let restoreViewport = (): void => {}

const userTurn: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Rename the module' }],
  timestamp: 1,
  source: 'transcript'
}

const pendingQuestion: NativeChatAsyncQuestionsView = {
  state: 'ready',
  questions: [{ key: 'q-a', index: 0, title: 'Which name?', options: ['core', 'base'] }]
}

function transcript(
  asyncQuestions: NativeChatAsyncQuestionsView | undefined
): NativeChatLiveSession {
  return {
    messages: [userTurn],
    status: 'ready',
    sessionId: 'session-async',
    agent: 'codex',
    hookAwaitingInput: false,
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready',
    ...(asyncQuestions ? { asyncQuestions } : {})
  }
}

function renderPane(): void {
  render(
    <NativeChatResolvedView
      paneKey={paneKey}
      agent="codex"
      sessionId="session-async"
      transcriptPath={null}
      isVisible
      isFocusedGroup={false}
      targetPtyId={ptyId}
      terminalTabId="tab-async"
      ownsTabWideLaunchDraft={false}
    />
  )
}

function asyncCard(): Element | null {
  return document.querySelector('[data-native-chat-async-questions-card]')
}

function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

beforeEach(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
  setDriverForPty(ptyId, { kind: 'idle' })
})

afterEach(() => {
  clearNativeChatAsyncQuestionCardStoreForTests()
  cleanup()
  restoreViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
  setDriverForPty(ptyId, { kind: 'idle' })
})

describe('NativeChatResolvedView async question card placement', () => {
  it('sits in the prompt slot, after the transcript and above a composer that stays', () => {
    retained.session = transcript(pendingQuestion)

    renderPane()

    const card = asyncCard()
    expect(card).not.toBeNull()
    expect(screen.getByText('Which name?')).toBeInTheDocument()
    const composer = screen.getByTestId('composer')
    expect(follows(card!, composer)).toBe(true)
    expect(follows(screen.getByText('Rename the module'), card!)).toBe(true)
  })

  it('gives way to a blocking card, which owns the prompt slot', () => {
    retained.session = transcript(pendingQuestion)
    useAppStore.getState().setAgentStatus(paneKey, {
      state: 'waiting',
      prompt: 'Rename the module',
      agentType: 'codex',
      interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf dist' } })
    })

    renderPane()

    expect(screen.getByText('Allow Bash?')).toBeInTheDocument()
    expect(asyncCard()).toBeNull()
  })

  it('is not offered while a phone holds the terminal', () => {
    retained.session = transcript(pendingQuestion)
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })

    renderPane()

    expect(asyncCard()).toBeNull()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it.each<[string, NativeChatAsyncQuestionsView | undefined]>([
    ['an old host', undefined],
    ['a host still reconstructing', { state: 'pending' }],
    ['an empty set', { state: 'ready', questions: [] }]
  ])('draws nothing for %s', (_label, view) => {
    retained.session = transcript(view)

    renderPane()

    expect(asyncCard()).toBeNull()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })
})
