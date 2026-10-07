import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import type * as WorktreeExecutionHostResolution from '../../shared/worktree-execution-host-resolution'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const {
  getActiveMultiplexerMock,
  getSshConnectionStoreMock,
  registerRemoteWorkspaceNotificationHandlerMock,
  resolveWorktreeExecutionHostCalls
} = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn(),
  registerRemoteWorkspaceNotificationHandlerMock: vi.fn(() => vi.fn()),
  resolveWorktreeExecutionHostCalls: { count: 0 }
}))

// Counts ownership resolutions without changing any of them.
vi.mock('../../shared/worktree-execution-host-resolution', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof WorktreeExecutionHostResolution
  return {
    ...actual,
    resolveWorktreeExecutionHost: (
      ...args: Parameters<typeof actual.resolveWorktreeExecutionHost>
    ) => {
      resolveWorktreeExecutionHostCalls.count += 1
      return actual.resolveWorktreeExecutionHost(...args)
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock,
  getSshConnectionStore: getSshConnectionStoreMock
}))

vi.mock('./remote-workspace-events', () => ({
  registerRemoteWorkspaceNotificationHandler: registerRemoteWorkspaceNotificationHandlerMock
}))

import { _resetRemoteWorkspaceCachesForTests } from './remote-workspace'
import {
  createRemoteWorkspaceExportDriver,
  type RemoteWorkspaceExportDriver
} from './remote-workspace-export-test-harness'
import { remoteWorkspaceSessionMatchesSnapshot } from './remote-workspace-snapshot-normalization'

function snapshot(session: RemoteWorkspaceSession, revision = 7): RemoteWorkspaceSnapshot {
  return {
    namespace: 'target',
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session
  }
}

const baseSession = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
} as WorkspaceSessionState

type PatchParams = { patch: { session: RemoteWorkspaceSession } }

const targets: SshTarget[] = [
  {
    id: 'target-1',
    label: 'Target 1',
    host: 'one.example.com',
    port: 22,
    username: 'alice'
  },
  {
    id: 'target-2',
    label: 'Target 2',
    host: 'two.example.com',
    port: 22,
    username: 'alice'
  }
]

describe('remoteWorkspaceSessionMatchesSnapshot', () => {
  it('matches normalized equivalent sessions', () => {
    expect(
      remoteWorkspaceSessionMatchesSnapshot(
        snapshot({
          activeWorktreePath: null,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        }),
        {
          activeWorktreePath: null,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {},
          activeWorktreePathsOnShutdown: undefined,
          activeTabIdByWorktreePath: undefined,
          remoteSessionIdsByTabId: undefined,
          lastVisitedAtByWorktreePath: undefined
        }
      )
    ).toBe(true)
  })

  it('treats empty optional projection fields as equivalent to absent fields', () => {
    expect(
      remoteWorkspaceSessionMatchesSnapshot(
        snapshot({
          activeWorktreePath: null,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {},
          activeWorktreePathsOnShutdown: [],
          activeTabIdByWorktreePath: {},
          remoteSessionIdsByTabId: {},
          lastVisitedAtByWorktreePath: {}
        }),
        {
          activeWorktreePath: null,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        }
      )
    ).toBe(true)
  })

  it('detects actual target session changes', () => {
    expect(
      remoteWorkspaceSessionMatchesSnapshot(
        snapshot({
          activeWorktreePath: '/repo',
          activeTabId: 'tab-1',
          tabsByWorktreePath: {
            '/repo': [{ id: 'tab-1', type: 'terminal', title: 'Shell' } as never]
          },
          terminalLayoutsByTabId: {}
        }),
        {
          activeWorktreePath: '/repo',
          activeTabId: 'tab-2',
          tabsByWorktreePath: {
            '/repo': [{ id: 'tab-2', type: 'terminal', title: 'Shell 2' } as never]
          },
          terminalLayoutsByTabId: {}
        }
      )
    ).toBe(false)
  })
})

describe('main exports a session write to the hosts it agrees with', () => {
  const requestByTargetId = new Map<string, ReturnType<typeof vi.fn>>()
  const muxByTargetId = new Map<string, { request: ReturnType<typeof vi.fn> }>()
  const getRepoMock = vi.fn<Store['getRepo']>()
  // Ownership resolution reads the catalog, not one id-keyed row, so the fake has to project one.
  const getReposMock = vi.fn(() => {
    const repo = getRepoMock('repo-target-1')
    return repo ? [repo] : []
  })
  let driver: RemoteWorkspaceExportDriver

  const sessionWithTab: WorkspaceSessionState = {
    activeRepoId: 'repo-target-1',
    activeWorktreeId: 'repo-target-1::/repo',
    activeTabId: 'tab-store',
    tabsByWorktree: {
      'repo-target-1::/repo': [
        {
          id: 'tab-store',
          title: 'Store shell',
          ptyId: 'pty-store',
          worktreeId: 'repo-target-1::/repo',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {}
  }

  const emptyRemoteSession: RemoteWorkspaceSession = {
    activeWorktreePath: null,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {}
  }

  function patchRequests(targetId: string): unknown[][] {
    return (requestByTargetId.get(targetId)?.mock.calls ?? []).filter(
      ([method]) => method === 'workspace.patch'
    )
  }

  beforeEach(() => {
    _resetRemoteWorkspaceCachesForTests()
    requestByTargetId.clear()
    muxByTargetId.clear()
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.removeHandler).mockReset()
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => targets,
      getTarget: (targetId: string) => targets.find((target) => target.id === targetId)
    })
    getRepoMock.mockReset()
    getReposMock.mockClear()
    getRepoMock.mockImplementation((repoId: string) =>
      repoId === 'repo-target-1'
        ? ({
            id: 'repo-target-1',
            path: '/remote/repo',
            displayName: 'Repo',
            badgeColor: 'blue',
            addedAt: 1,
            connectionId: 'target-1'
          } as never)
        : undefined
    )
    getActiveMultiplexerMock.mockReset()
    getActiveMultiplexerMock.mockImplementation((targetId: string) => {
      let mux = muxByTargetId.get(targetId)
      if (!mux) {
        const request = vi.fn().mockImplementation((method: string, params: PatchParams) => {
          if (method === 'workspace.get') {
            return Promise.resolve(
              snapshot({
                activeWorktreePath: '/previous',
                activeTabId: null,
                tabsByWorktreePath: {},
                terminalLayoutsByTabId: {}
              })
            )
          }
          return Promise.resolve({
            ok: true,
            snapshot: snapshot(params.patch.session, 8)
          })
        })
        mux = { request }
        muxByTargetId.set(targetId, mux)
        requestByTargetId.set(targetId, request)
      }
      return mux
    })
    registerRemoteWorkspaceNotificationHandlerMock.mockClear()
    driver = createRemoteWorkspaceExportDriver({ getRepo: getRepoMock, getRepos: getReposMock })
  })

  async function observeTarget(targetId: string): Promise<RemoteWorkspaceObservedSnapshot> {
    const observed = await driver.handlers.get('remoteWorkspace:get')?.(null, { targetId })
    if (!observed || typeof observed !== 'object' || !('hostObservationToken' in observed)) {
      throw new Error(`remoteWorkspace:get did not observe ${targetId}`)
    }
    return observed as RemoteWorkspaceObservedSnapshot
  }

  async function agreeWith(targetId: string): Promise<void> {
    const { revision, hostObservationToken } = await observeTarget(targetId)
    driver.agree(targetId, { revision, hostObservationToken })
  }

  it('reads the repo catalog once per export, not once per worktree', async () => {
    // `store.getRepos()` re-hydrates every repo row. The export asks "is this worktree mine?" once
    // per worktree, so reading the catalog inside that callback multiplied hydration by the
    // worktree count — 413 on the session that surfaced this.
    await agreeWith('target-1')
    await Promise.resolve()
    getReposMock.mockClear()
    const worktrees = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`repo-target-1::/remote/repo-${index}`, []])
    )

    driver.write({ ...baseSession, tabsByWorktree: worktrees })
    await driver.nextPushes()

    expect(getReposMock).toHaveBeenCalledTimes(1)
  })

  it('resolves each worktree ownership once for the whole export, not once per target', async () => {
    // Ownership is a function of the repo catalog alone; only the final `=== targetId` differs, so
    // exporting to N targets used to repeat the identical resolution N times per worktree key.
    for (const target of targets) {
      await agreeWith(target.id)
    }
    await Promise.resolve()
    getReposMock.mockClear()
    resolveWorktreeExecutionHostCalls.count = 0
    const worktrees = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`repo-target-1::/remote/repo-${index}`, []])
    )

    driver.write({ ...baseSession, tabsByWorktree: worktrees })
    await driver.nextPushes()

    expect(getReposMock).toHaveBeenCalledTimes(1)
    // 6 worktree keys resolved once each, regardless of how many targets are exported to.
    expect(resolveWorktreeExecutionHostCalls.count).toBe(6)
  })

  it('skips the session and repo-catalog reads when no agreed target is connected', async () => {
    // A disconnected target leaves nothing to project onto, so a session write must not pay for a
    // full repo hydration it never uses.
    driver.agree('target-1', { revision: 7, hostObservationToken: 'token' })
    getActiveMultiplexerMock.mockReturnValue(undefined)
    await Promise.resolve()
    getReposMock.mockClear()

    driver.write(sessionWithTab)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getReposMock).not.toHaveBeenCalled()
    expect(driver.pushes).toEqual([])
  })

  it('exports nothing to a host this desktop has no valid agreement with', async () => {
    driver.importPeer({
      targetId: 'target-1',
      revision: -1,
      hostObservationToken: 'token',
      outcome: 'synced',
      patches: []
    })
    driver.importPeer({
      targetId: 'target-1',
      revision: 7,
      hostObservationToken: '',
      outcome: 'synced',
      patches: []
    })

    driver.write(sessionWithTab)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
    expect(driver.pushes).toEqual([])
  })

  it('writes only to agreed connected targets', async () => {
    await agreeWith('target-1')
    driver.agree('missing-target', { revision: 7, hostObservationToken: 'unreachable' })

    driver.write(sessionWithTab)
    const [push] = await driver.nextPushes()

    expect(push).toMatchObject({ targetId: 'target-1', result: { ok: true } })
    expect(getActiveMultiplexerMock).not.toHaveBeenCalledWith('target-2')
    expect(patchRequests('target-1')).toEqual([
      [
        'workspace.patch',
        expect.objectContaining({ patch: expect.objectContaining({ kind: 'replace-session' }) })
      ]
    ])
    expect(requestByTargetId.get('target-2')).toBeUndefined()
  })

  it('exports the persisted store session', async () => {
    await agreeWith('target-1')

    driver.write(sessionWithTab)
    await driver.nextPushes()

    expect(patchRequests('target-1')).toEqual([
      [
        'workspace.patch',
        expect.objectContaining({
          patch: expect.objectContaining({
            session: expect.objectContaining({
              activeWorktreePath: '/repo',
              activeTabId: 'tab-store'
            })
          })
        })
      ]
    ])
  })

  it('does not invalidate an agreement when an unchanged snapshot is polled', async () => {
    const first = await observeTarget('target-1')
    const second = await observeTarget('target-1')
    expect(second.hostObservationToken).toBe(first.hostObservationToken)
    driver.agree('target-1', first)

    driver.write(sessionWithTab)

    await expect(driver.nextPushes()).resolves.toMatchObject([
      { targetId: 'target-1', result: { ok: true } }
    ])
  })

  it('exports nothing for an import, and once for the next local change', async () => {
    const observed = await observeTarget('target-1')
    driver.importPeer({
      ...observed,
      targetId: 'target-1',
      outcome: 'synced',
      patches: [{ patch: sessionWithTab }]
    })
    // The window saves back what it applied from the import.
    driver.write(sessionWithTab)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patchRequests('target-1')).toEqual([])

    driver.write({ ...sessionWithTab, activeTabId: null })
    await driver.nextPushes()
    expect(patchRequests('target-1')).toHaveLength(1)
  })

  it('keeps the agreement after an unavailable relay, so the next local change retries', async () => {
    await agreeWith('target-1')
    requestByTargetId
      .get('target-1')
      ?.mockImplementationOnce(async () => ({ ok: false, reason: 'unavailable' }))

    driver.write(sessionWithTab)
    await expect(driver.nextPushes()).resolves.toMatchObject([
      { result: { ok: false, reason: 'unavailable' } }
    ])
    driver.write({ ...sessionWithTab, activeTabId: null })
    await expect(driver.nextPushes()).resolves.toMatchObject([{ result: { ok: true } }])

    expect(patchRequests('target-1')).toHaveLength(2)
  })

  it('reports nothing for an export a newer pull superseded', async () => {
    const observed = await observeTarget('target-1')
    driver.agree('target-1', observed)
    let finishPatch: (result: unknown) => void = () => {}
    const request = requestByTargetId.get('target-1')
    request?.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPatch = resolve
        })
    )

    driver.write(sessionWithTab)
    await vi.waitFor(() => expect(patchRequests('target-1')).toHaveLength(1))
    driver.importPeer({ ...observed, targetId: 'target-1', outcome: 'synced', patches: [] })
    finishPatch({ ok: false, reason: 'stale-revision', snapshot: snapshot(emptyRemoteSession, 9) })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(driver.pushes).toEqual([])
  })

  it('keeps a conflicted target out of exports until a whole pull agrees again', async () => {
    const observed = await observeTarget('target-1')
    driver.agree('target-1', observed)
    driver.agree('target-1', observed, 'conflict')

    driver.write(sessionWithTab)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patchRequests('target-1')).toEqual([])

    driver.agree('target-1', observed)
    driver.write({ ...sessionWithTab, activeTabId: null })
    await driver.nextPushes()
    expect(patchRequests('target-1')).toHaveLength(1)
  })

  it.each([
    ['seeds an empty host from a desktop that has tabs for it', true],
    ['leaves an empty host alone when this desktop has nothing for it', false]
  ])('%s', async (_name, hasTabs) => {
    const request = vi.fn(async (method: string, params: Partial<PatchParams>) =>
      method === 'workspace.get'
        ? snapshot(emptyRemoteSession, 0)
        : { ok: true, snapshot: snapshot(params.patch?.session ?? emptyRemoteSession, 1) }
    )
    muxByTargetId.set('target-1', { request })
    requestByTargetId.set('target-1', request)
    driver.write(hasTabs ? sessionWithTab : baseSession)
    const observed = await observeTarget('target-1')
    expect(observed.revision).toBe(0)

    driver.agree('target-1', observed)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patchRequests('target-1')).toHaveLength(hasTabs ? 1 : 0)
    expect(driver.pushes).toMatchObject(
      hasTabs ? [{ targetId: 'target-1', authority: { revision: 0 }, result: { ok: true } }] : []
    )
  })
})
