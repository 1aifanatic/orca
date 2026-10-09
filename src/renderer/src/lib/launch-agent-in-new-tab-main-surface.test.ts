// Real-store coverage: a launch into the floating workspace must leave the main window's tab alone.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../store/slices/store-cascades-test-harness'

const storeBox = vi.hoisted(() => {
  const box: { store: unknown } = { store: null }
  return box
})
const callRuntimeRpc = vi.hoisted(() =>
  vi.fn<(target: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>>()
)
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: vi.fn(async () => true)
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

vi.mock('@/store', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))

createStoreCascadesMockApi()

const MAIN_WORKTREE_ID = 'repo1::/path/wt1'

function seedMainWindowOnEditor(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  storeBox.store = store
  seedStore(store, {
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: {
      repo1: [makeWorktree({ id: MAIN_WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: MAIN_WORKTREE_ID
  })
  const mainTerminal = store.getState().createTab(MAIN_WORKTREE_ID)
  // The main window is showing a non-terminal tab, as in the report.
  store.getState().setActiveTabType('editor', MAIN_WORKTREE_ID)
  expect(store.getState().activeTabId).toBe(mainTerminal.id)
  return store
}

describe('launchAgentInNewTab main-window surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callRuntimeRpc.mockReturnValue(new Promise(() => {}))
  })

  it('selects a floating launch in the floating panel without moving the main window', async () => {
    const store = seedMainWindowOnEditor()
    const before = store.getState()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      agent: 'opencode',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    expect(result?.surface.kind).toBe('local-terminal')
    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : null
    const state = store.getState()
    expect(state.activeTabType).toBe('editor')
    expect(state.activeTabId).toBe(before.activeTabId)
    expect(state.activeTabTypeByWorktree[MAIN_WORKTREE_ID]).toBe('editor')
    // Why: the floating panel renders the group's active tab, so the launch still lands selected there.
    const floatingGroup = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(floatingGroup?.activeTabId).toBe(tabId)
    expect(state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(tabId)
    expect(state.activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('terminal')
  })

  it('still brings a launch in the active worktree to the front', async () => {
    const store = seedMainWindowOnEditor()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'opencode',
      worktreeId: MAIN_WORKTREE_ID
    })

    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : null
    expect(tabId).not.toBeNull()
    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeTabId).toBe(tabId)
  })

  it('admits a menu launch once with a held pane and no renderer startup queue', async () => {
    const store = seedMainWindowOnEditor()
    const beforeSurfaceOpen = vi.fn(() => {
      expect(callRuntimeRpc).not.toHaveBeenCalled()
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const { agentLaunchPaneSpawnHold } = await import('./agent-launch-pane-spawn-hold')
    const result = launchAgentInNewTab({
      requestId: 'menu-click',
      agent: 'claude',
      worktreeId: MAIN_WORKTREE_ID,
      groupId: store.getState().activeGroupIdByWorktree[MAIN_WORKTREE_ID],
      beforeSurfaceOpen,
      pendingActivationSpawn: true,
      quickCommandLabel: 'Review'
    })
    expect(beforeSurfaceOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'local-terminal' })
    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : ''
    const tab = store.getState().tabsByWorktree[MAIN_WORKTREE_ID]?.find((tab) => tab.id === tabId)
    expect(tab?.agentLaunchPane).toBeDefined()
    expect(agentLaunchPaneSpawnHold(tabId, tab?.agentLaunchPane?.leafId ?? '')).not.toBeNull()
    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'agent.launch',
      expect.objectContaining({
        paneKey: `${tabId}:${tab?.agentLaunchPane?.leafId}`,
        prompt: {
          text: '',
          delivery: 'submit',
          transport: { kind: 'desktop-new-tab', promptDelivery: 'auto-submit' }
        },
        presentation: 'focused'
      })
    )
    expect(tab).toMatchObject({ quickCommandLabel: 'Review', pendingActivationSpawn: true })
    expect(result?.promptDeliveryResult).toBeUndefined()
  })

  it('routes the actual agent Quick Command through the host with its label and group history', async () => {
    const store = seedMainWindowOnEditor()
    const groupId = store.getState().activeGroupIdByWorktree[MAIN_WORKTREE_ID]
    const { runQuickCommandInNewTab } = await import('./run-quick-command-in-new-tab')
    const result = runQuickCommandInNewTab({
      worktreeId: MAIN_WORKTREE_ID,
      groupId,
      command: {
        id: 'review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this diff'
      }
    })
    expect(result?.tabId).toBeDefined()
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'agent.launch',
      expect.objectContaining({
        launchSource: 'quick_command',
        placement: { groupId },
        prompt: {
          text: 'Review this diff',
          delivery: 'submit',
          transport: { kind: 'desktop-new-tab', promptDelivery: 'auto-submit' }
        }
      })
    )
    expect(store.getState().pendingStartupByTabId).toEqual({})
    const tab = store
      .getState()
      .tabsByWorktree[MAIN_WORKTREE_ID]?.find((tab) => tab.id === result?.tabId)
    expect(tab?.quickCommandLabel).toBe('Review')
  })

  it('routes the actual dashboard existing-workspace launch through the same host', async () => {
    const store = seedMainWindowOnEditor()
    const { launchDashboardAgent } = await import('../components/dashboard/launch-dashboard-agent')
    expect(launchDashboardAgent({ worktreeId: MAIN_WORKTREE_ID, agent: 'codex' })).toBe(true)
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'agent.launch',
      expect.objectContaining({
        target: { kind: 'existing', worktree: `id:${MAIN_WORKTREE_ID}` },
        launchSource: 'unknown'
      })
    )
    expect(store.getState().pendingStartupByTabId).toEqual({})
  })

  it('admits SSH through the local desktop host with no renderer execution fallback', async () => {
    const store = seedMainWindowOnEditor()
    store.setState({
      repos: store.getState().repos.map((repo) => ({
        ...repo,
        connectionId: 'ssh-owned',
        executionHostId: 'ssh:ssh-owned'
      })),
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: MAIN_WORKTREE_ID,
            repoId: 'repo1',
            path: '/remote/wt1',
            hostId: 'ssh:ssh-owned'
          })
        ]
      }
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const result = launchAgentInNewTab({
      requestId: 'ssh-click',
      agent: 'claude',
      worktreeId: MAIN_WORKTREE_ID
    })
    expect(result?.surface.kind).toBe('local-terminal')
    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'agent.launch',
      expect.objectContaining({
        target: { kind: 'existing', worktree: `id:${MAIN_WORKTREE_ID}` }
      })
    )
    expect(store.getState().pendingStartupByTabId).toEqual({})
  })

  it('keeps an inactive launch in its original pane without moving selection', async () => {
    const store = seedMainWindowOnEditor()
    const before = store.getState()
    const target = 'repo1::/path/inactive'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const result = launchAgentInNewTab({
      requestId: 'inactive-click',
      agent: 'claude',
      worktreeId: target
    })
    expect(store.getState().activeWorktreeId).toBe(MAIN_WORKTREE_ID)
    expect(store.getState().activeTabId).toBe(before.activeTabId)
    expect(store.getState().activeTabType).toBe('editor')
    expect(callRuntimeRpc.mock.calls[0]?.[2]).toMatchObject({ presentation: 'background' })
    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : ''
    store.getState().setActiveWorktree(target)
    expect(store.getState().tabsByWorktree[target]?.map((tab) => tab.id)).toEqual([tabId])
    expect(store.getState().activeTabId).toBe(tabId)
    expect(callRuntimeRpc).toHaveBeenCalledOnce()
  })

  it('leaves floating activate:false selection to the floating group', async () => {
    const store = seedMainWindowOnEditor()
    const before = store.getState()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const result = launchAgentInNewTab({
      requestId: 'floating-click',
      agent: 'claude',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activate: false
    })
    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : ''
    store.getState().setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tabId)
    store.getState().activateTab(tabId)
    expect(store.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]?.activeTabId).toBe(
      tabId
    )
    expect(store.getState().activeTabId).toBe(before.activeTabId)
    expect(store.getState().activeTabType).toBe('editor')
    expect(callRuntimeRpc.mock.calls[0]?.[2]).toMatchObject({ presentation: 'background' })
  })

  it.each(['draft', 'auto-submit'] as const)(
    'sends typed %s with its main prompt bytes and callbacks',
    async (promptDelivery) => {
      const store = seedMainWindowOnEditor()
      let finish!: (value: unknown) => void
      callRuntimeRpc.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const onPromptDelivered = vi.fn()
      const result = launchAgentInNewTab({
        requestId: 'typed-click',
        agent: 'claude',
        worktreeId: MAIN_WORKTREE_ID,
        prompt: '  original\n"quote"\tbytes  ',
        promptDelivery,
        agentArgs: null,
        initialCwd: '/path/wt1/app',
        onPromptDelivered
      })
      const params = callRuntimeRpc.mock.calls[0]?.[2]
      expect(params).toMatchObject({
        agentArgs: null,
        cwd: '/path/wt1/app',
        prompt: {
          text: 'original\n"quote"\tbytes',
          delivery: promptDelivery === 'draft' ? 'draft' : 'submit',
          transport: { kind: 'desktop-new-tab', promptDelivery }
        }
      })
      expect(result?.promptDeliveryResult).toBeUndefined()
      expect(onPromptDelivered).not.toHaveBeenCalled()
      finish({
        outcome: { kind: 'terminal', handle: 'term_1', paneKey: params?.paneKey },
        worktreeId: MAIN_WORKTREE_ID,
        receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: '' },
        prompt: {
          delivery: promptDelivery === 'draft' ? 'draft' : 'submit',
          outcome: 'handed-to-terminal'
        }
      })
      await vi.waitFor(() => expect(onPromptDelivered).toHaveBeenCalledOnce())
      expect(store.getState().pendingStartupByTabId).toEqual({})
    }
  )

  it.each(['session-continuation', 'session-fork'] as const)(
    'retains the renderer native-prefill path for %s',
    async (launchPurpose) => {
      const store = seedMainWindowOnEditor()
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const onPromptDelivered = vi.fn()
      const result = launchAgentInNewTab({
        requestId: 'context-click',
        agent: 'claude',
        worktreeId: MAIN_WORKTREE_ID,
        prompt: 'context',
        promptDelivery: 'draft',
        launchPurpose,
        onPromptDelivered
      })
      const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : ''
      expect(callRuntimeRpc).not.toHaveBeenCalled()
      expect(store.getState().pendingStartupByTabId[tabId]?.command).toContain('--prefill')
      expect(onPromptDelivered).toHaveBeenCalledOnce()
    }
  )
})
