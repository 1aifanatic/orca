// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { terminalTabFixture } from './native-chat-workspace-test-fixtures'
import type {
  NativeChatLiveSession,
  UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'
import type { NativeChatComposerProps } from './native-chat-composer-types'

const mocks = vi.hoisted(() => {
  const captured: {
    sessionArgs: UseNativeChatLiveSessionArgs[]
    composerProps: NativeChatComposerProps | null
    composerMounts: number
    cancelAccepted: boolean
  } = { sessionArgs: [], composerProps: null, composerMounts: 0, cancelAccepted: true }
  return Object.assign(captured, { cancel: vi.fn(), clearEchoes: vi.fn() })
})

const workingSession: NativeChatLiveSession = {
  messages: [
    {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Rename the module' }],
      timestamp: 1,
      source: 'transcript'
    }
  ],
  status: 'working',
  sessionId: 'session-m',
  agent: 'claude',
  hookAwaitingInput: false,
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: (args: UseNativeChatLiveSessionArgs) => {
    mocks.sessionArgs.push(args)
    return workingSession
  }
}))
vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: (props: NativeChatComposerProps) => {
    mocks.composerProps = props
    useEffect(() => {
      mocks.composerMounts += 1
    }, [])
    return null
  }
}))
vi.mock('./use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: () => ({
    sendAnswer: () => ({ settleAfterMs: 0 }),
    sendRaw: () => {},
    sendRawVerified: async () => false,
    cancelPending: () => {},
    cancelAsk: async () => false,
    cancel: () => {
      mocks.cancel()
      return mocks.cancelAccepted
    }
  })
}))
vi.mock('./use-native-chat-pending-delivery', () => ({
  useNativeChatPendingDelivery: () => ({
    pending: [],
    notices: new Map(),
    record: () => undefined,
    clear: mocks.clearEchoes,
    cancel: () => {},
    reject: () => {},
    holdUnconfirmed: () => {}
  })
}))

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { useAppStore } = await import('../../store')
const { installNativeChatMessageListTestViewport } =
  await import('./native-chat-message-list-test-viewport')

const TAB = 'tab-m'
const MEMBER = { 'wt-1': [terminalTabFixture(TAB, 'wt-1')] }
let restoreViewport = (): void => {}

function pane(isVisible = true): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatResolvedView
        paneKey={`${TAB}:leaf`}
        agent="claude"
        sessionId="session-m"
        transcriptPath={null}
        isVisible={isVisible}
        isFocusedGroup={false}
        targetPtyId="pty-m"
        terminalTabId={TAB}
        worktreeId="wt-1"
        ownsTabWideLaunchDraft={false}
      />
    </TooltipProvider>
  )
}

function lastSessionArgs(): UseNativeChatLiveSessionArgs | undefined {
  return mocks.sessionArgs.at(-1)
}

function workingAttr(): string | null {
  return (
    document.querySelector('[data-native-chat-root]')?.getAttribute('data-native-chat-working') ??
    null
  )
}

beforeEach(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  mocks.sessionArgs = []
  mocks.composerProps = null
  mocks.composerMounts = 0
  mocks.cancelAccepted = true
  mocks.cancel.mockReset()
  mocks.clearEchoes.mockReset()
  useAppStore.setState({
    agentStatusByPaneKey: {},
    nativeChatLaunchPromptByTabId: {},
    tabsByWorktree: MEMBER
  })
})

afterEach(() => {
  cleanup()
  restoreViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, tabsByWorktree: {} })
})

describe('bridge chat workspace membership', () => {
  it('suspends transcript IO on a membership miss instead of reading locally, and resumes on return', () => {
    render(pane())
    expect(lastSessionArgs()?.enabled).toBe(true)

    // Moved to another workspace: the old global search would follow it there.
    act(() => useAppStore.setState({ tabsByWorktree: { 'wt-1': [], 'wt-2': MEMBER['wt-1'] } }))
    expect(lastSessionArgs()?.enabled).toBe(false)

    act(() => useAppStore.setState({ tabsByWorktree: MEMBER }))
    expect(lastSessionArgs()?.enabled).toBe(true)
    // Readiness changes flow through props: the composer, and its draft, never remount.
    expect(mocks.composerMounts).toBe(1)
  })

  it('keeps a hidden pane suspended when its membership returns', () => {
    useAppStore.setState({ tabsByWorktree: {} })
    const view = render(pane(false))
    expect(lastSessionArgs()?.enabled).toBe(false)
    act(() => useAppStore.setState({ tabsByWorktree: MEMBER }))
    expect(lastSessionArgs()?.enabled).toBe(false)
    view.rerender(pane(true))
    expect(lastSessionArgs()?.enabled).toBe(true)
  })

  it('keeps a retitled row current', () => {
    render(pane())
    act(() =>
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [terminalTabFixture(TAB, 'wt-1', { title: 'Renamed' })] }
      })
    )
    expect(lastSessionArgs()?.enabled).toBe(true)
  })

  it('does not present a refused Stop as an interruption', () => {
    mocks.cancelAccepted = false
    render(pane())
    expect(workingAttr()).toBe('true')

    act(() => mocks.composerProps?.onStop?.())
    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(workingAttr()).toBe('true')
    expect(mocks.clearEchoes).not.toHaveBeenCalled()
  })

  it('applies Stop effects once the interrupt was dispatched', () => {
    render(pane())
    act(() => mocks.composerProps?.onStop?.())
    expect(workingAttr()).toBe('false')
    expect(mocks.clearEchoes).toHaveBeenCalledOnce()
  })
})
