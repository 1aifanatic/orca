// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

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

const REASON = 'Saved by a newer Orca. Update Orca to continue this chat.'

const PENDING_APPROVAL: AgentJournalRenderItem = {
  itemId: 'approval-item',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'approval',
    title: 'Allow command?',
    detail: 'pnpm test',
    options: [{ id: 'allow', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

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

it('locks the composer with the reason as its placeholder, in place of a card it would refuse', () => {
  mocks.readOnly = 'written-by-newer-orca'
  mocks.promptItems = [PENDING_APPROVAL]
  renderSession()
  expect(screen.getByTestId('structured-composer')).toBeTruthy()
  expect(mocks.composerProps).toMatchObject({ canSend: false, lockReason: REASON })
  expect(document.querySelector('[data-native-chat-approval-card-mock]')).toBeNull()
  expect(screen.queryByText(REASON)).toBeNull()
})

it('leaves the composer open on a writable chat, or for a reason this client cannot word', () => {
  renderSession()
  expect(mocks.composerProps).toMatchObject({ canSend: true, lockReason: undefined })
  cleanup()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for an arm a newer host could publish, which this build's type cannot name.
  mocks.readOnly = 'a-later-reason' as 'written-by-newer-orca'
  renderSession()
  expect(mocks.composerProps).toMatchObject({ canSend: true, lockReason: undefined })
})
