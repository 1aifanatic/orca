// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
})

const NOTICE =
  "This chat was saved by a newer Orca, so it's read-only here. Update Orca to continue this chat."

function renderSession() {
  return render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="read-only-tab"
      sessionId="read-only-session"
      target={{ kind: 'local' }}
      agent="claude"
    />
  )
}

it('says up front that a newer Orca saved the chat and that updating continues it', () => {
  mocks.readOnly = 'written-by-newer-orca'
  renderSession()
  expect(screen.getByText(NOTICE).getAttribute('role')).toBe('status')
})

it('says nothing on a writable chat, or for a reason this client cannot word', () => {
  renderSession()
  expect(screen.queryByText(/saved by a newer Orca/)).toBeNull()
  cleanup()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for an arm a newer host could publish, which this build's type cannot name.
  mocks.readOnly = 'a-later-reason' as 'written-by-newer-orca'
  renderSession()
  expect(screen.queryByText(/saved by a newer Orca/)).toBeNull()
})
