import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const { prepareEphemeralVmWorkspaceTargetMock } = vi.hoisted(() => ({
  prepareEphemeralVmWorkspaceTargetMock: vi.fn()
}))

type TestActiveView = 'terminal' | 'tasks'

const store = {
  settings: {
    activeRuntimeEnvironmentId: null as string | null,
    experimentalNativeChat: undefined as boolean | undefined,
    openAgentTabsInChatByDefault: undefined as boolean | undefined
  },
  activeView: 'terminal' as TestActiveView,
  activePendingCreationId: 'creation-1' as string | null,
  repos: [{ id: 'repo-runtime', connectionId: null }],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    store.pendingWorktreeCreations[entry.creationId] = entry
    store.activePendingCreationId = entry.creationId
  }),
  updatePendingWorktreeCreation: vi.fn(
    (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
      const entry = store.pendingWorktreeCreations[creationId]
      if (entry) {
        store.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    }
  ),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
  }),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {})),
  setupProjectExistingFolder: vi.fn(),
  refreshRuntimeEnvironmentStatus: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree: {} as Record<string, { id: string; launchAgent?: string }[]>,
  unifiedTabsByWorktree: {}
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-1'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => false)
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareEphemeralVmWorkspaceTargetMock
}))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { continueBackgroundWorktreeCreation } from './worktree-creation-flow'

beforeEach(() => {
  vi.clearAllMocks()
  store.settings.activeRuntimeEnvironmentId = null
  store.settings.experimentalNativeChat = undefined
  store.settings.openAgentTabsInChatByDefault = undefined
  store.activeView = 'terminal'
  store.activePendingCreationId = 'creation-1'
  store.repos = []
  store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(makeRequest()) }
  store.createWorktree.mockImplementation(() => new Promise(() => {}))
  store.tabsByWorktree = {}
  store.unifiedTabsByWorktree = {}
  vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
})

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function makePendingCreation(request: WorktreeCreationRequest): PendingWorktreeCreation {
  return {
    creationId: 'creation-1',
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request
  }
}

describe('worktree creation launch draft seeding', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { api: {} })
  })

  it('seeds the chat-composer launch draft on completion for draft launches', async () => {
    store.activeView = 'terminal'
    store.activePendingCreationId = 'creation-1'
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' }
    })
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: 'tab-1' })

    const started = continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({
        agent: 'claude',
        startupPlan: {
          agent: 'claude',
          launchCommand: 'claude --prefill x',
          expectedProcess: 'claude',
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        },
        launchDraftPrompt: 'https://github.com/o/r/issues/12'
      })
    )

    expect(started).toBe(true)
    await vi.waitFor(() =>
      expect(store.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
        tabId: 'tab-1',
        agent: 'claude',
        text: 'https://github.com/o/r/issues/12',
        createdAt: expect.any(Number)
      })
    )
  })

  it('seeds the backend-spawned agent tab, not the worktree default terminal tab', async () => {
    // Repo default tabs ("dev server", "logs", …) make activation's primaryTabId
    // a tab that runs no agent; main's startup terminal is the agent's own tab.
    store.activeView = 'terminal'
    store.activePendingCreationId = 'creation-1'
    store.tabsByWorktree = { 'wt-1': [{ id: 'dev-server' }, { id: 'agent-tab' }] }
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' },
      startupTerminal: { tabId: 'agent-tab', spawned: true }
    })
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: 'dev-server' })

    continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({
        agent: 'claude',
        startupPlan: {
          agent: 'claude',
          launchCommand: 'claude --prefill x',
          expectedProcess: 'claude',
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        },
        launchDraftPrompt: 'https://github.com/o/r/issues/12'
      })
    )

    await vi.waitFor(() => expect(store.seedNativeChatLaunchDraft).toHaveBeenCalled())
    expect(store.seedNativeChatLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'agent-tab' })
    )
    const createCall = store.createWorktree.mock.calls[0] as unknown[] | undefined
    expect(createCall?.[25]).toEqual({
      startupDraft: 'https://github.com/o/r/issues/12'
    })
  })

  it.each([
    ['mirrorable local Grok', 'grok', 'https://github.com/o/r/issues/12', 'chat'],
    ['multi-line Claude', 'claude', 'note\nhttps://github.com/o/r/issues/12', 'chat']
  ] as const)('passes %s draft mode to backend startup', async (_label, agent, draft, viewMode) => {
    store.settings.experimentalNativeChat = true
    store.settings.openAgentTabsInChatByDefault = true
    store.repos = [{ id: 'repo-1', connectionId: null }]
    continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({
        agent,
        startup: { command: `${agent} --prefill x`, launchAgent: agent },
        startupPlan: {
          agent,
          launchCommand: `${agent} --prefill x`,
          expectedProcess: agent,
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        },
        launchDraftPrompt: draft
      })
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    const createCall = store.createWorktree.mock.calls[0] as unknown[] | undefined
    expect(createCall?.[16]).toEqual({
      command: `${agent} --prefill x`,
      launchAgent: agent,
      viewMode
    })
  })

  it('carries launchDraftText into activation for an argv-prefill launch', async () => {
    // Why: the draft rides inside `launchCommand` here, so the plan sets no
    // draftPrompt — without launchDraftText the initial view-mode decision
    // never sees a draft and opens chat on an unmirrorable one.
    store.activeView = 'terminal'
    store.activePendingCreationId = 'creation-1'
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' }
    })
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: 'tab-1' })

    continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({
        agent: 'claude',
        startupPlan: {
          agent: 'claude',
          launchCommand: "claude --prefill 'https://github.com/o/r/issues/12'",
          expectedProcess: 'claude',
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        },
        launchDraftPrompt: 'https://github.com/o/r/issues/12'
      })
    )

    await vi.waitFor(() => expect(activateAndRevealWorktree).toHaveBeenCalled())
    const startup = vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[1]?.startup
    expect(startup?.draftPrompt).toBeUndefined()
    expect(startup?.launchDraftText).toBe('https://github.com/o/r/issues/12')
  })

  it('does not seed a launch draft without draft launch context', async () => {
    store.activeView = 'terminal'
    store.activePendingCreationId = 'creation-1'
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' }
    })
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: 'tab-1' })

    continueBackgroundWorktreeCreation(
      'creation-1',
      makeRequest({
        agent: 'claude',
        startupPlan: {
          agent: 'claude',
          launchCommand: 'claude',
          expectedProcess: 'claude',
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      })
    )

    await vi.waitFor(() => expect(activateAndRevealWorktree).toHaveBeenCalled())
    expect(store.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
  })
})
