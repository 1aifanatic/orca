// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
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

// An approval whose subject a newer Orca wrote, with no detail to show.
const NEWER_APPROVAL: AgentJournalRenderItem = JSON.parse(
  JSON.stringify({
    itemId: 'approval-item',
    revision: 3,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'Review proposed change',
      detail: null,
      subject: { kind: 'diff', path: 'a.ts' },
      options: [{ id: 'allow', label: 'Approve' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  })
)

it("hands the card a newer Orca's subject in a writable chat, and its cancel ends the turn", () => {
  mocks.turnId = 'turn-1'
  mocks.promptItems = [NEWER_APPROVAL]
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="newer-approval-tab"
      sessionId="newer-approval-session"
      target={{ kind: 'local' }}
      agent="claude"
    />
  )
  expect(mocks.approvalCardProps).toMatchObject({
    disabled: false,
    approval: { subject: { kind: 'diff' } }
  })
  expect(mocks.approvalCardProps?.approval).not.toHaveProperty('detail')
  mocks.approvalCardProps?.onCancel?.()
  expect(mocks.cancel).toHaveBeenCalledWith('turn-1', {
    itemId: 'approval-item',
    expectedRevision: 3
  })
})
