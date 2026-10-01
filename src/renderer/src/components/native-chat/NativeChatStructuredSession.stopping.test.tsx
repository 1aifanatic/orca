// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const hostStatus = vi.hoisted((): { emit: ((event: AgentSessionStatusEvent) => void) | null } => ({
  emit: null
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  ...moduleFactories.structuredAgentSessionClient(),
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    onEvent: (event: AgentSessionStatusEvent) => void
  ) => {
    hostStatus.emit = onEvent
    return { unsubscribe: () => {} }
  }
}))
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

function renderPane(): void {
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-tab-1"
      sessionId="session-1"
      target={{ kind: 'local' }}
      agent="codex"
    />
  )
}

/** The host's summary for the pane's session, as its status feed publishes it. */
function hostSays(stopping: boolean): void {
  act(() =>
    hostStatus.emit?.({
      type: 'status',
      session: {
        sessionId: 'session-1',
        workspaceId: 'wt-1',
        agent: 'codex',
        status: 'working',
        latestPrompt: 'work on this',
        updatedAt: Date.now(),
        ...(stopping ? { stopping: true as const } : {})
      }
    })
  )
}

describe("the chat pane while a person's Stop ends the turn", () => {
  afterEach(() => {
    hostSays(false)
    cleanup()
    resetStructuredSessionMocks()
  })

  it("reads Stopping from the host's word and keeps Stop for the repeat that escalates", async () => {
    mocks.turnId = 'turn-1'
    mocks.isWorking = true
    renderPane()
    await waitFor(() => expect(hostStatus.emit).not.toBeNull())
    expect(mocks.composerProps).toMatchObject({ isWorking: true, isStopping: false })

    hostSays(true)

    // A Stop the provider took and never answered (a Codex command) ends only at a second Stop.
    await waitFor(() => expect(mocks.messageListProps).toMatchObject({ stopping: true }))
    expect(mocks.composerProps).toMatchObject({ isStopping: false })
    mocks.composerProps?.onStop?.()
    expect(mocks.stop).toHaveBeenCalledOnce()
  })

  it('reads Stopping from its own press, and holds Stop until that request answers', () => {
    mocks.turnId = 'turn-1'
    mocks.stopPressed = true
    renderPane()

    expect(mocks.composerProps).toMatchObject({ isStopping: true })
    expect(mocks.messageListProps).toMatchObject({ stopping: true })
    mocks.composerProps?.onStop?.()
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('stops normally while nothing is stopping', () => {
    mocks.turnId = 'turn-1'
    renderPane()

    expect(mocks.composerProps).toMatchObject({ isStopping: false })
    mocks.composerProps?.onStop?.()
    expect(mocks.stop).toHaveBeenCalledOnce()
  })

  it('reads nothing once the chat has nothing left to stop', async () => {
    renderPane()
    await waitFor(() => expect(hostStatus.emit).not.toBeNull())

    hostSays(true)

    expect(mocks.composerProps).toMatchObject({ isStopping: false })
    expect(mocks.messageListProps).toMatchObject({ stopping: false })
  })
})
