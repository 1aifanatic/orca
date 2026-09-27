import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'

const WORKTREE_ID = 'repo::/worktree'
const REPO_ID = 'repo'
const LIVE_REPO = {
  id: REPO_ID,
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
} as const
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const SPLIT_ROOT = {
  type: 'split' as const,
  direction: 'vertical' as const,
  first: { type: 'leaf' as const, leafId: LEFT },
  second: { type: 'leaf' as const, leafId: RIGHT }
}

// A cold restore: the persisted split survives, and an earlier incarnation change left the repo's
// terminal membership host-authoritative, but no PTY has registered yet.
function makeColdRestoredSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: 'pty-left',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: SPLIT_ROOT,
        activeLeafId: LEFT,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
      }
    },
    terminalTopologyRevisionByRepoId: { [REPO_ID]: 2 }
  }
}

function makeRendererFrame(
  extraTabs: readonly RuntimeMobileSessionSnapshotTab[] = []
): RuntimeMobileSessionTabsSnapshot {
  const parentLayout = {
    root: SPLIT_ROOT,
    activeLeafId: LEFT,
    expandedLeafId: LEFT,
    ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
  }
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: `tab::${LEFT}`,
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'group', activeTabId: 'tab', tabOrder: ['tab', ...extraTabs.map((tab) => tab.id)] }
    ],
    tabs: [
      {
        type: 'terminal',
        id: `tab::${LEFT}`,
        parentTabId: 'tab',
        leafId: LEFT,
        ptyId: 'pty-left',
        title: 'Left',
        parentLayout,
        isActive: true
      },
      {
        type: 'terminal',
        id: `tab::${RIGHT}`,
        parentTabId: 'tab',
        leafId: RIGHT,
        ptyId: 'pty-right',
        title: 'Right',
        parentLayout,
        isActive: false
      },
      ...extraTabs
    ]
  }
}

function publishRendererFrame(
  runtime: OrcaRuntimeService,
  extraTabs: readonly RuntimeMobileSessionSnapshotTab[] = []
): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEFT,
        layout: SPLIT_ROOT
      }
    ],
    leaves: [],
    mobileSessionTabs: [makeRendererFrame(extraTabs)]
  })
}

function coldRestoredRuntime(): OrcaRuntimeService {
  const session = makeColdRestoredSession()
  // The desktop window is live, so main must not rebuild the list from the persisted session.
  setRuntimeDesktopSurface({
    showNotification: () => false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only isDestroyed off its authoritative window on this path.
    findWindowById: () => ({ isDestroyed: () => false }) as never,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list and fence paths read only repos and the workspace session; the rest of Store is unreached.
    {
      getRepos: () => [LIVE_REPO],
      getWorkspaceSession: () => session,
      // The production store commits asynchronously; a synchronous flush on this path is a bug.
      flushOrThrow: () => {
        throw new Error('synchronous flush')
      }
    } as never
  )
  runtime.attachWindow(1)
  return runtime
}

async function listedSurfaces(runtime: OrcaRuntimeService): Promise<string[]> {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  return result.tabs.map((tab) => `${tab.id}:${'status' in tab ? tab.status : ''}`)
}

describe('a renderer frame fenced before its PTY registered', () => {
  afterEach(() => setRuntimeDesktopSurface(null))

  it.each([
    ['local', null],
    ['SSH', 'ssh-1']
  ])('%s: re-derives the fence once the PTY registers', async (_host, connectionId) => {
    const runtime = coldRestoredRuntime()
    publishRendererFrame(runtime)
    expect(await listedSurfaces(runtime)).toEqual([])
    const published: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => published.push(event))

    runtime.registerPty('pty-left', WORKTREE_ID, connectionId, {
      tabId: 'tab',
      leafId: LEFT,
      incarnationId: 'incarnation-restored'
    })

    expect(published.at(-1)?.tabs.map((tab) => tab.id)).toEqual([`tab::${LEFT}`])
    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`])
    // The renderer's unchanged resend must not undo or churn the re-derived list.
    publishRendererFrame(runtime)
    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`])
    unsubscribe()
  })

  it('keeps a surface whose PTY never returns fenced when a sibling registers', async () => {
    const runtime = coldRestoredRuntime()
    publishRendererFrame(runtime)

    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: LEFT,
      incarnationId: 'incarnation-restored'
    })
    runtime.registerPty('pty-other', WORKTREE_ID, null, {
      tabId: 'tab-other',
      leafId: RIGHT,
      incarnationId: 'incarnation-other'
    })

    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`])
  })
})

// An SSH worktree: the phone closes renderer-listed tab-y while relaunched tab-x is still fenced.
const SSH_REPO = { ...LIVE_REPO, connectionId: 'ssh-1' }
const SSH_PTY_X = 'ssh:ssh-1@@pty-x'
const SSH_PTY_Y = 'ssh:ssh-1@@pty-y'

function makeSshSession(tabIds: readonly ('tab-x' | 'tab-y')[]): WorkspaceSessionState {
  // tab-x's relaunched PTY has not bound yet, so only tab-y persists a relay binding.
  const specs = {
    'tab-x': { leafId: LEFT, ptyId: null },
    'tab-y': { leafId: RIGHT, ptyId: SSH_PTY_Y }
  }
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: tabIds.map((id, index) => ({
        id,
        ptyId: specs[id].ptyId,
        worktreeId: WORKTREE_ID,
        title: id,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: index + 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      tabIds.map((id) => [
        id,
        {
          root: { type: 'leaf' as const, leafId: specs[id].leafId },
          activeLeafId: specs[id].leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: specs[id].ptyId ? { [specs[id].leafId]: specs[id].ptyId } : {}
        }
      ])
    ),
    terminalTopologyRevisionByRepoId: { [REPO_ID]: 2 }
  }
}

function publishSshRendererFrame(runtime: OrcaRuntimeService): void {
  const surfaces = [
    { tabId: 'tab-x', leafId: LEFT, ptyId: SSH_PTY_X },
    { tabId: 'tab-y', leafId: RIGHT, ptyId: SSH_PTY_Y }
  ]
  runtime.syncWindowGraph(1, {
    tabs: surfaces.map(({ tabId, leafId }) => ({
      tabId,
      worktreeId: WORKTREE_ID,
      title: tabId,
      activeLeafId: leafId,
      layout: { type: 'leaf' as const, leafId }
    })),
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WORKTREE_ID,
        publicationEpoch: 'renderer',
        snapshotVersion: 1,
        activeGroupId: 'group',
        activeTabId: `tab-y::${RIGHT}`,
        activeTabType: 'terminal',
        tabGroups: [{ id: 'group', activeTabId: 'tab-y', tabOrder: ['tab-x', 'tab-y'] }],
        tabs: surfaces.map(({ tabId, leafId, ptyId }) => ({
          type: 'terminal' as const,
          id: `${tabId}::${leafId}`,
          parentTabId: tabId,
          leafId,
          ptyId,
          title: tabId,
          isActive: tabId === 'tab-y'
        }))
      }
    ]
  })
}

function sshRuntimeWithRendererCloseRelay(kill: (ptyId: string) => boolean): OrcaRuntimeService {
  let session = makeSshSession(['tab-x', 'tab-y'])
  setRuntimeDesktopSurface({
    showNotification: () => false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only liveness and send off its authoritative window on these paths.
    findWindowById: () =>
      ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: () => {} }
      }) as never,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list, fence and close paths read only repos and the workspace session; the rest of Store is unreached.
    withDurableRuntimeStore({
      getRepos: () => [SSH_REPO],
      getRepo: (id: string) => (id === REPO_ID ? SSH_REPO : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => [],
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      flushPendingOrThrowAsync: async () => {}
    }) as never
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close path uses only these two relays.
  runtime.setNotifier({
    closeTerminal: vi.fn(),
    // The renderer durably retires the tab and acks; its pruned frame is still in flight.
    closeTerminalTab: vi.fn(async () => {
      session = makeSshSession(['tab-x'])
    })
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close path kills and inventories only; the remote kill lands asynchronously.
  runtime.setPtyController({
    write: () => true,
    kill,
    listProcesses: vi.fn(async () =>
      [SSH_PTY_X, SSH_PTY_Y].map((id) => ({ id, cwd: '/worktree', title: 'shell' }))
    ),
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  return runtime
}

describe('re-deriving a fenced frame after the host retired another surface', () => {
  afterEach(() => setRuntimeDesktopSurface(null))

  it('keeps a phone-closed terminal closed while its remote PTY is still exiting', async () => {
    const kill = vi.fn(() => true)
    const runtime = sshRuntimeWithRendererCloseRelay(kill)
    publishSshRendererFrame(runtime)
    runtime.registerPty(SSH_PTY_Y, WORKTREE_ID, 'ssh-1', {
      tabId: 'tab-y',
      leafId: RIGHT,
      incarnationId: 'incarnation-y'
    })
    expect(await listedSurfaces(runtime)).toEqual([`tab-y::${RIGHT}:ready`])

    await runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, 'tab-y', { reason: 'user' })
    expect(kill).toHaveBeenCalledWith(SSH_PTY_Y)
    expect(await listedSurfaces(runtime)).toEqual([])

    runtime.registerPty(SSH_PTY_X, WORKTREE_ID, 'ssh-1', {
      tabId: 'tab-x',
      leafId: LEFT,
      incarnationId: 'incarnation-x'
    })

    expect(await listedSurfaces(runtime)).toEqual([`tab-x::${LEFT}:ready`])
  })

  it('keeps a phone-closed chat tab closed when the fenced terminal registers', async () => {
    const runtime = coldRestoredRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat close path uses only this relay.
    runtime.setNotifier({ closeSessionTab: vi.fn(async () => {}) } as never)
    publishRendererFrame(runtime, [
      {
        type: 'agent-session',
        id: 'chat',
        title: 'Chat',
        sessionId: 'session-chat',
        agent: 'claude',
        isActive: false
      }
    ])
    expect(await listedSurfaces(runtime)).toEqual(['chat:'])

    await runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, 'chat', { reason: 'user' })
    expect(await listedSurfaces(runtime)).toEqual([])

    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: LEFT,
      incarnationId: 'incarnation-restored'
    })

    expect(await listedSurfaces(runtime)).toEqual([`tab::${LEFT}:ready`])
  })
})

// A phone creates a terminal while the desktop's frame still lacks it: the spawn registered and the
// host published the tab itself, as it does for a create the desktop has not published yet.
const PHONE_LEAF = '33333333-3333-4333-8333-333333333333'

async function runtimeWithUnpublishedPhoneCreate(): Promise<OrcaRuntimeService> {
  const session = makeColdRestoredSession()
  const handlers = new Map<string, (event: unknown, reply: unknown) => void>()
  let runtime: OrcaRuntimeService | null = null
  const webContents = {
    isDestroyed: () => false,
    setBackgroundThrottling: () => {},
    send: (channel: string, payload: { requestId: string }) => {
      if (channel !== 'terminal:requestTabCreate') {
        return
      }
      runtime?.registerPty('pty-phone', WORKTREE_ID, null, {
        tabId: 'tab-phone',
        leafId: PHONE_LEAF,
        incarnationId: 'incarnation-phone'
      })
      handlers.get('terminal:tabCreateReply')?.(
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-phone', title: 'Terminal' }
      )
    }
  }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path reads only liveness and these webContents members off its authoritative window.
    findWindowById: () => ({ isDestroyed: () => false, webContents }) as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the tab-create reply channel is registered on this path.
    onIpc: (channel, listener) => handlers.set(channel, listener as never),
    removeIpcListener: (channel) => handlers.delete(channel)
  })
  runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list, fence and create paths read only repos and the workspace session; the rest of Store is unreached.
    {
      getRepos: () => [LIVE_REPO],
      getWorkspaceSession: () => session,
      flushOrThrow: () => {
        throw new Error('synchronous flush')
      }
    } as never
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path focuses only when activating, which this create does not.
  runtime.setNotifier({ focusTerminal: vi.fn() } as never)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: WORKTREE_ID,
      path: '/worktree',
      connectionId: null,
      repo: LIVE_REPO,
      folderWorkspace: null
    }))
  })
  runtime.attachWindow(1)
  publishRendererFrame(runtime)
  await runtime.createMobileSessionTerminal(`id:${WORKTREE_ID}`, {
    activate: false,
    clientNavigationId: 'phone'
  })
  return runtime
}

describe('re-deriving a fenced frame after the host added a surface', () => {
  afterEach(() => setRuntimeDesktopSurface(null))

  it('keeps a phone-created terminal listed and runtime-owned when a fenced surface registers', async () => {
    const runtime = await runtimeWithUnpublishedPhoneCreate()
    expect(await listedSurfaces(runtime)).toEqual([`tab-phone::${PHONE_LEAF}:ready`])

    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: LEFT,
      incarnationId: 'incarnation-restored'
    })

    expect(await listedSurfaces(runtime)).toEqual([
      `tab::${LEFT}:ready`,
      `tab-phone::${PHONE_LEAF}:ready`
    ])
  })
})
