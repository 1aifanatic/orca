import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { NotificationDispatchRequest } from '../../../shared/notification-settings-types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import {
  createTestStore,
  makeTabGroup,
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'
import { dispatchStructuredTurnCompletionAttention } from '@/components/native-chat/structured-attention-dispatch'
import type { StructuredTab } from '@/components/native-chat/structured-agent-session-tabs'
import {
  buildNotificationHostOptions,
  getNotificationExecutionHostId
} from './notification-execution-host'

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/lib/desktop-notification-sound', () => ({ playDesktopNotificationSound: vi.fn() }))
vi.mock('@/lib/blocked-notification-fallback', () => ({
  showBlockedNotificationFallbackToast: vi.fn()
}))

const store = createTestStore()
const paneKey = 'terminal:11111111-1111-4111-8111-111111111111'
const leafId = '11111111-1111-4111-8111-111111111111'
const sent: NotificationDispatchRequest[] = []

beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('window', {
    api: {
      notifications: {
        dispatch: vi.fn(async (request: NotificationDispatchRequest) => {
          sent.push(request)
          return { delivered: true }
        })
      }
    }
  })
  vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
})
afterEach(() => vi.unstubAllGlobals())

function seed(
  hostId: ExecutionHostId,
  ptyId: string,
  folder: boolean,
  collision = false
): StructuredTab {
  const workspaceId = folder ? 'folder:folder-1' : 'repo1::/tmp/wt'
  const tab: StructuredTab = {
    ...makeUnifiedTab({
      id: 'chat',
      worktreeId: workspaceId,
      groupId: 'group',
      entityId: 'session',
      agentSessionAgent: 'claude',
      executionHostId: hostId
    }),
    contentType: 'agent-session'
  }
  const folderRow: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: 'group',
    name: 'Folder',
    folderPath: '/tmp/folder',
    executionHostId: hostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  store.setState({
    settings: createGlobalSettingsFixture(),
    repos: [{ ...TEST_REPO, executionHostId: hostId }],
    worktreesByRepo: {
      repo1: [
        ...(collision ? [makeWorktree({ id: workspaceId, repoId: 'repo1', hostId: 'local' })] : []),
        makeWorktree({
          id: workspaceId,
          repoId: 'repo1',
          hostId,
          ...(ptyId.startsWith('remote:') ? { runtimeOwnerEnvironmentId: 'hub' } : {})
        })
      ]
    },
    folderWorkspaces: folder ? [folderRow] : [],
    projectGroups: [],
    activeWorktreeId: 'another-workspace',
    activeTabId: null,
    tabsByWorktree: {
      [workspaceId]: [makeTab({ id: 'terminal', worktreeId: workspaceId, ptyId })]
    },
    ptyIdsByTabId: { terminal: [ptyId] },
    terminalLayoutsByTabId: {
      terminal: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    },
    unifiedTabsByWorktree: { [workspaceId]: [tab] },
    groupsByWorktree: {
      [workspaceId]: [
        makeTabGroup({
          id: 'group',
          worktreeId: workspaceId,
          activeTabId: 'chat',
          tabOrder: ['chat']
        })
      ]
    },
    activeGroupIdByWorktree: { [workspaceId]: 'group' },
    agentStatusByPaneKey: {},
    suppressedPtyExitIds: {},
    unreadAgentCompletionPanes: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    sshTargetLabels: new Map(),
    sshConnectionStates: new Map(),
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    updateFolderWorkspace: async () => true
  })
  return tab
}

function dispatchChat(
  tab: StructuredTab,
  subscriptionTarget?: { kind: 'environment'; environmentId: string }
): void {
  dispatchStructuredTurnCompletionAttention(
    tab,
    {
      sessionId: 'session',
      turnId: 'turn',
      outcome: 'success',
      completedAt: 100,
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'host-workspace',
        workspaceKind: 'git-worktree'
      }
    },
    subscriptionTarget
  )
}

it.each([
  { name: 'local', hostId: 'local', ptyId: 'pty-local' },
  { name: 'SSH', hostId: 'ssh:qa', ptyId: 'ssh:qa@@pty-1' },
  { name: 'paired runtime', hostId: 'runtime:hub', ptyId: 'remote:hub@@pty-1' },
  {
    name: 'direct recipe VM',
    hostId: 'ssh:runtime-ssh-vm-a',
    ptyId: 'ssh:runtime-ssh-vm-a@@pty-1'
  },
  {
    name: 'recipe VM through a paired server',
    hostId: 'ssh:runtime-ssh-vm-a',
    ptyId: 'remote:hub@@pty-1'
  }
] satisfies { name: string; hostId: ExecutionHostId; ptyId: string }[])(
  'lists both senders’ machines for $name, in git and folder workspaces',
  ({ hostId, ptyId }) => {
    for (const folder of [false, true]) {
      sent.length = 0
      const tab = seed(hostId, ptyId, folder)
      dispatchTerminalNotification(tab.worktreeId, { source: 'terminal-bell', paneKey })
      dispatchChat(tab)
      expect(sent).toHaveLength(2)
      const terminalHost = ptyId.startsWith('remote:') ? 'runtime:hub' : hostId
      expect(sent.map((request) => request.executionHostId)).toEqual([terminalHost, hostId])
      const listed = buildNotificationHostOptions(store.getState()).map((host) => host.id)
      for (const request of sent) {
        expect(listed).toContain(request.executionHostId)
      }
    }
  }
)

it('uses the background pane and explicit chat host when workspace ids collide', () => {
  const tab = seed('ssh:qa', 'ssh:qa@@pty-1', false, true)
  dispatchTerminalNotification(tab.worktreeId, { source: 'terminal-bell', paneKey })
  dispatchChat(tab)
  expect(sent.map((request) => request.executionHostId)).toEqual(['ssh:qa', 'ssh:qa'])
  expect(buildNotificationHostOptions(store.getState()).map((host) => host.id)).toContain('ssh:qa')
})

it('keeps a captured PTY owner when the pane binding has not hydrated', () => {
  const tab = seed('local', 'pty-local', false)
  dispatchTerminalNotification(tab.worktreeId, {
    source: 'terminal-bell',
    paneKey,
    ptyId: 'ssh:qa@@pty-1'
  })
  expect(sent[0]?.executionHostId).toBe('ssh:qa')
})

it('uses the structured subscription target when the tab has no explicit host', () => {
  const tab = seed('runtime:hub', 'remote:hub@@pty-1', false, true)
  dispatchChat(
    { ...tab, executionHostId: undefined },
    { kind: 'environment', environmentId: 'hub' }
  )
  expect(sent[0]?.executionHostId).toBe('runtime:hub')
  expect(buildNotificationHostOptions(store.getState()).map((host) => host.id)).toContain(
    'runtime:hub'
  )
})

it('does not turn an opaque remote PTY into a local notification', () => {
  const tab = seed('local', 'remote:unqualified', false)
  expect(getNotificationExecutionHostId(store.getState(), tab.worktreeId, { paneKey })).toEqual({})
})
