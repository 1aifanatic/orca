import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { openDefaultAgentChatInEmptyWorkspace } from './empty-workspace-default-agent-chat'

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(),
  planAgentSessionLaunch: vi.fn()
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: mocks.planAgentSessionLaunch
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))

const initialAppStoreState = useAppStore.getState()

function seedSettings(settings: Partial<GlobalSettings>): void {
  useAppStore.setState({
    detectedAgentIds: ['claude', 'codex'],
    settings: {
      ...getDefaultSettings('/tmp'),
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      ...settings
    }
  })
}

beforeEach(() => {
  mocks.planAgentSessionLaunch.mockReturnValue({ route: 'structured-native-chat' })
  mocks.launchAgentInNewTab.mockReturnValue({
    surface: { kind: 'local-agent-session', tabId: 'chat-tab', sessionId: 's-1' }
  })
})

afterEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(initialAppStoreState, true)
})

describe('openDefaultAgentChatInEmptyWorkspace', () => {
  it('launches the default agent as a chat', () => {
    seedSettings({})

    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toEqual({ primaryTabId: 'chat-tab' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', worktreeId: 'wt-1', pendingActivationSpawn: true })
    )
  })

  it('does nothing unless new agent tabs open as chat', () => {
    seedSettings({ openAgentTabsInChatByDefault: false })

    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toBeNull()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('respects a Blank Terminal default agent', () => {
    seedSettings({ defaultTuiAgent: 'blank' })

    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toBeNull()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('does not start an agent that could only open as a terminal here', () => {
    seedSettings({})
    mocks.planAgentSessionLaunch.mockReturnValue({ route: 'terminal-tui' })

    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toBeNull()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })
})
