// @vitest-environment happy-dom

// "Not confirmed" marks a message whose outcome the host lost, and only while nothing running could
// still deliver it: a working agent, or a start or attach still in flight, may yet answer it, so the
// label waits for idle instead of flashing as every reopen passes through those states.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
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

const NOT_CONFIRMED = "Not confirmed. Send it again if the agent didn't answer it."

const LOST: AgentJournalSubmission = {
  clientMessageId: 'lost',
  fence: 1,
  payloadFingerprint: 'fp',
  dispatchState: 'unknown',
  providerItemId: null,
  reason: 'host_restarted_before_acknowledgement',
  recovered: true,
  submittedAt: 1,
  resolvedAt: 1
}

function pane() {
  return (
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="not-confirmed-tab"
      sessionId="not-confirmed-session"
      target={{ kind: 'local' }}
      agent="claude"
    />
  )
}

function lostRowNotice(): string | null {
  return (
    document.querySelector(`[data-message-id="${agentJournalSubmissionKey('lost')}"]`)
      ?.textContent ?? null
  )
}

it('hides "Not confirmed" while the agent works, and shows it once the agent is idle', async () => {
  mocks.submissions = [LOST]
  mocks.isWorking = true
  const view = render(pane())
  expect(screen.queryByText(NOT_CONFIRMED)).toBeNull()

  mocks.isWorking = false
  view.rerender(pane())
  await waitFor(() => expect(lostRowNotice()).toBe(NOT_CONFIRMED))
})

it('hides "Not confirmed" while the chat is still being started or attached', async () => {
  mocks.submissions = [LOST]
  mocks.launchLifecycle = 'pending'
  const view = render(pane())
  expect(mocks.controllerProps?.transportEnabled).toBe(false)
  expect(screen.queryByText(NOT_CONFIRMED)).toBeNull()

  mocks.launchLifecycle = 'published'
  view.rerender(pane())
  await waitFor(() => expect(lostRowNotice()).toBe(NOT_CONFIRMED))
})
