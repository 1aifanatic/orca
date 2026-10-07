import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const {
  getActiveMultiplexerMock,
  getSshConnectionStoreMock,
  registerRemoteWorkspaceNotificationHandlerMock
} = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn(),
  registerRemoteWorkspaceNotificationHandlerMock: vi.fn(() => vi.fn())
}))

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

import {
  _resetRemoteWorkspaceCachesForTests,
  handleRemoteWorkspaceNotification
} from './remote-workspace'
import {
  createRemoteWorkspaceExportDriver,
  type RemoteWorkspaceExportDriver
} from './remote-workspace-export-test-driver'
import { CLIENT_ID } from './remote-workspace-client-identity'
import { queueRemoteWorkspacePatch } from './remote-workspace-patch-queue'
import {
  REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES,
  getCachedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'

function snapshot(session: RemoteWorkspaceSession, revision = 7): RemoteWorkspaceSnapshot {
  return {
    namespace: 'target',
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session
  }
}

function sessionWithTab(worktreeId: string, tabId: string): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: worktreeId,
    activeTabId: tabId,
    tabsByWorktree: {
      [worktreeId]: [{ id: tabId, type: 'terminal', title: 'Shell', worktreeId } as never]
    },
    terminalLayoutsByTabId: {}
  }
}

function patchSession(params: Record<string, unknown>): RemoteWorkspaceSession {
  return (params.patch as { session: RemoteWorkspaceSession }).session
}

describe('main export patch queue', () => {
  let driver: RemoteWorkspaceExportDriver
  const muxByTargetId = new Map<string, { request: ReturnType<typeof vi.fn> }>()
  const getRepoMock = vi.fn<Store['getRepo']>()
  // Ownership resolution reads the catalog, not one id-keyed row, so the fake has to project one.
  const KNOWN_REPO_IDS = ['repo-target-1', 'repo-target-2', 'repo-reset', 'repo-newer']
  const store: Partial<Store> = {
    getRepo: getRepoMock,
    getRepos: () =>
      KNOWN_REPO_IDS.flatMap((repoId) => {
        const repo = getRepoMock(repoId)
        return repo ? [repo] : []
      })
  }

  const target: SshTarget = {
    id: 'target-1',
    label: 'Target 1',
    host: 'one.example.com',
    port: 22,
    username: 'alice'
  }

  beforeEach(() => {
    _resetRemoteWorkspaceCachesForTests()
    muxByTargetId.clear()
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.removeHandler).mockReset()
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => [target],
      getTarget: (targetId: string) => (targetId === target.id ? target : undefined)
    })
    getRepoMock.mockReset()
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
    getActiveMultiplexerMock.mockImplementation((targetId: string) => muxByTargetId.get(targetId))
    registerRemoteWorkspaceNotificationHandlerMock.mockClear()

    driver = createRemoteWorkspaceExportDriver(store)
  })

  function observeSnapshot(targetId: string, value: RemoteWorkspaceSnapshot): string {
    return rememberRemoteWorkspaceSnapshot(targetId, value).hostObservationToken
  }

  function cachedObservationToken(targetId: string): string {
    const cached = getCachedRemoteWorkspaceSnapshot(targetId)
    if (!cached) {
      throw new Error(`No cached workspace observation for ${targetId}`)
    }
    return cached.hostObservationToken
  }

  it('serializes overlapping exports for the same target so they use fresh base revisions', async () => {
    let currentRevision = 7
    let releaseFirstPatch!: () => void
    const firstPatchCanFinish = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve
    })
    const patchBaseRevisions: number[] = []
    const request = vi
      .fn()
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'workspace.get') {
          return snapshot(
            {
              activeWorktreePath: '/previous',
              activeTabId: null,
              tabsByWorktreePath: {},
              terminalLayoutsByTabId: {}
            },
            currentRevision
          )
        }
        if (method === 'workspace.patch') {
          patchBaseRevisions.push(params.baseRevision as number)
          if (patchBaseRevisions.length === 1) {
            await firstPatchCanFinish
          }
          currentRevision += 1
          const patchedSnapshot = snapshot(patchSession(params), currentRevision)
          handleRemoteWorkspaceNotification('target-1', 'workspace.changed', {
            snapshot: patchedSnapshot,
            sourceClientId: CLIENT_ID
          })
          return {
            ok: true,
            snapshot: patchedSnapshot
          }
        }
        throw new Error(`Unexpected method ${method}`)
      })
    muxByTargetId.set('target-1', { request })
    const observationToken = observeSnapshot(
      'target-1',
      snapshot(
        {
          activeWorktreePath: '/previous',
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        },
        7
      )
    )

    driver.agree('target-1', { revision: 7, hostObservationToken: observationToken })
    const pushes = driver.nextPushes(2)
    driver.write(sessionWithTab('repo-target-1::/remote/workspace-a', 'tab-a'))
    await vi.waitFor(() => expect(patchBaseRevisions).toEqual([7]))

    driver.write(sessionWithTab('repo-target-1::/remote/workspace-b', 'tab-b'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patchBaseRevisions).toEqual([7])

    releaseFirstPatch()
    await expect(pushes).resolves.toMatchObject([
      {
        targetId: 'target-1',
        result: {
          ok: true,
          snapshot: { revision: 8, hostObservationToken: observationToken }
        }
      },
      {
        targetId: 'target-1',
        authority: { revision: 8 },
        result: {
          ok: true,
          snapshot: { revision: 9, hostObservationToken: observationToken }
        }
      }
    ])
    expect(patchBaseRevisions).toEqual([7, 8])
  })

  it('rejects token A after a different same-revision host observation arrives before admission', async () => {
    const remoteSnapshot = snapshot(
      {
        activeWorktreePath: '/other-device',
        activeTabId: 'host-tab',
        tabsByWorktreePath: {
          '/other-device': [{ id: 'host-tab', worktreePath: '/other-device' } as never]
        },
        terminalLayoutsByTabId: {}
      },
      7
    )
    const request = vi.fn()
    muxByTargetId.set('target-1', { request })
    const observationToken = observeSnapshot(
      'target-1',
      snapshot(
        {
          activeWorktreePath: '/previous',
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        },
        7
      )
    )

    driver.agree('target-1', { revision: 7, hostObservationToken: observationToken })
    handleRemoteWorkspaceNotification('target-1', 'workspace.changed', {
      snapshot: remoteSnapshot,
      sourceClientId: 'other-client'
    })
    driver.write(sessionWithTab('repo-target-1::/remote/workspace', 'stale-local-tab'))
    const result = await driver.nextPushes()

    expect(result).toMatchObject([
      {
        targetId: 'target-1',
        result: {
          ok: false,
          reason: 'stale-revision',
          snapshot: { revision: 7 }
        }
      }
    ])
    expect(request).not.toHaveBeenCalled()
  })

  it('drops a queued export when a host snapshot arrives while the first one is in flight', async () => {
    const remoteSnapshot = snapshot(
      {
        activeWorktreePath: '/other-device',
        activeTabId: 'host-tab',
        tabsByWorktreePath: {
          '/other-device': [{ id: 'host-tab', worktreePath: '/other-device' } as never]
        },
        terminalLayoutsByTabId: {}
      },
      8
    )
    let releasePatch!: () => void
    const patchCanFinish = new Promise<void>((resolve) => {
      releasePatch = resolve
    })
    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.get') {
        return snapshot(
          {
            activeWorktreePath: '/previous',
            activeTabId: null,
            tabsByWorktreePath: {},
            terminalLayoutsByTabId: {}
          },
          7
        )
      }
      if (method === 'workspace.patch') {
        await patchCanFinish
        return { ok: false, reason: 'stale-revision', snapshot: remoteSnapshot }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    muxByTargetId.set('target-1', { request })
    const observationToken = observeSnapshot(
      'target-1',
      snapshot(
        {
          activeWorktreePath: '/previous',
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        },
        7
      )
    )

    driver.agree('target-1', { revision: 7, hostObservationToken: observationToken })
    driver.write(sessionWithTab('repo-target-1::/remote/first', 'first-local-tab'))
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === 'workspace.patch')).toHaveLength(1)
    )
    driver.write(sessionWithTab('repo-target-1::/remote/queued', 'queued-local-tab'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    handleRemoteWorkspaceNotification('target-1', 'workspace.changed', {
      snapshot: remoteSnapshot,
      sourceClientId: 'other-client'
    })
    releasePatch()

    await expect(driver.nextPushes()).resolves.toMatchObject([
      { targetId: 'target-1', result: { ok: false, reason: 'stale-revision' } }
    ])
    // The stale reply ended the agreement; the queued export waits for the window's next pull.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(driver.pushes).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'workspace.patch')).toHaveLength(1)
  })

  it('rejects a queued export after a same-revision host observation replaces its lineage', async () => {
    const baseline = snapshot(
      {
        activeWorktreePath: '/baseline',
        activeTabId: null,
        tabsByWorktreePath: {},
        terminalLayoutsByTabId: {}
      },
      7
    )
    const replacement = snapshot(
      {
        activeWorktreePath: '/other-device',
        activeTabId: 'host-tab',
        tabsByWorktreePath: {
          '/other-device': [{ id: 'host-tab', worktreePath: '/other-device' } as never]
        },
        terminalLayoutsByTabId: {}
      },
      7
    )
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'workspace.patch') {
        throw new Error(`Unexpected method ${method}`)
      }
      return { ok: true, snapshot: snapshot(patchSession(params), 8) }
    })
    muxByTargetId.set('target-1', { request })
    handleRemoteWorkspaceNotification('target-1', 'workspace.changed', {
      snapshot: baseline,
      sourceClientId: CLIENT_ID
    })
    const observationToken = cachedObservationToken('target-1')

    let releaseBlocker!: () => void
    const blockerCanFinish = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    let blockerStarted!: () => void
    const blockerDidStart = new Promise<void>((resolve) => {
      blockerStarted = resolve
    })
    const blocker = queueRemoteWorkspacePatch('target-1', async () => {
      blockerStarted()
      await blockerCanFinish
    })
    await blockerDidStart

    driver.agree('target-1', { revision: 7, hostObservationToken: observationToken })
    const queued = driver.nextPushes()
    driver.write(sessionWithTab('repo-target-1::/remote/workspace', 'stale-local-tab'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    handleRemoteWorkspaceNotification('target-1', 'workspace.changed', {
      snapshot: replacement,
      sourceClientId: 'other-client'
    })
    releaseBlocker()
    await blocker

    await expect(queued).resolves.toMatchObject([
      {
        targetId: 'target-1',
        result: { ok: false, reason: 'stale-revision', snapshot: { revision: 7 } }
      }
    ])
    expect(request).not.toHaveBeenCalled()
  })

  it('fails closed after token A is evicted even when the fetched revision still matches', async () => {
    const baseline = snapshot(
      {
        activeWorktreePath: '/baseline',
        activeTabId: null,
        tabsByWorktreePath: {},
        terminalLayoutsByTabId: {}
      },
      7
    )
    const observationToken = observeSnapshot('target-1', baseline)
    for (let index = 0; index < REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES; index += 1) {
      observeSnapshot(`eviction-target-${index}`, baseline)
    }
    expect(getCachedRemoteWorkspaceSnapshot('target-1')).toBeUndefined()

    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.get') {
        return baseline
      }
      throw new Error(`Unexpected method ${method}`)
    })
    muxByTargetId.set('target-1', { request })

    driver.agree('target-1', { revision: 7, hostObservationToken: observationToken })
    driver.write(sessionWithTab('repo-target-1::/remote/workspace', 'stale-local-tab'))
    await expect(driver.nextPushes()).resolves.toMatchObject([
      {
        targetId: 'target-1',
        result: { ok: false, reason: 'stale-revision', snapshot: { revision: 7 } }
      }
    ])
    expect(request.mock.calls.map(([method]) => method)).toEqual(['workspace.get'])
  })

  it('patches independent agreed targets concurrently', async () => {
    const secondTarget: SshTarget = {
      id: 'target-2',
      label: 'Target 2',
      host: 'two.example.com',
      port: 22,
      username: 'alice'
    }
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => [target, secondTarget]
    })
    getRepoMock.mockImplementation((repoId: string) => {
      if (repoId === 'repo-target-1') {
        return {
          id: 'repo-target-1',
          path: '/remote/repo-a',
          displayName: 'Repo A',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'target-1'
        } as never
      }
      if (repoId === 'repo-target-2') {
        return {
          id: 'repo-target-2',
          path: '/remote/repo-b',
          displayName: 'Repo B',
          badgeColor: 'green',
          addedAt: 1,
          connectionId: 'target-2'
        } as never
      }
      return undefined
    })

    let releaseFirstPatch!: () => void
    const firstPatchCanFinish = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve
    })
    const previousSnapshot = snapshot(
      {
        activeWorktreePath: '/previous',
        activeTabId: null,
        tabsByWorktreePath: {},
        terminalLayoutsByTabId: {}
      },
      7
    )
    const slowRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.get') {
        return previousSnapshot
      }
      if (method === 'workspace.patch') {
        await firstPatchCanFinish
        return { ok: true, snapshot: snapshot(patchSession(params), 8) }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const fastRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.get') {
        return previousSnapshot
      }
      if (method === 'workspace.patch') {
        return { ok: true, snapshot: snapshot(patchSession(params), 8) }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    muxByTargetId.set('target-1', { request: slowRequest })
    muxByTargetId.set('target-2', { request: fastRequest })
    const firstObservationToken = observeSnapshot('target-1', previousSnapshot)
    const secondObservationToken = observeSnapshot('target-2', previousSnapshot)

    driver.agree('target-1', { revision: 7, hostObservationToken: firstObservationToken })
    driver.agree('target-2', { revision: 7, hostObservationToken: secondObservationToken })
    const resultPromise = driver.nextPushes(2)
    driver.write({
      ...sessionWithTab('repo-target-1::/remote/workspace-a', 'tab-a'),
      tabsByWorktree: {
        'repo-target-1::/remote/workspace-a': [
          {
            id: 'tab-a',
            type: 'terminal',
            title: 'Shell A',
            worktreeId: 'repo-target-1::/remote/workspace-a'
          } as never
        ],
        'repo-target-2::/remote/workspace-b': [
          {
            id: 'tab-b',
            type: 'terminal',
            title: 'Shell B',
            worktreeId: 'repo-target-2::/remote/workspace-b'
          } as never
        ]
      }
    })

    await vi.waitFor(() =>
      expect(slowRequest.mock.calls.some(([method]) => method === 'workspace.patch')).toBe(true)
    )
    await vi.waitFor(() =>
      expect(fastRequest.mock.calls.some(([method]) => method === 'workspace.patch')).toBe(true)
    )

    releaseFirstPatch()
    // The fast target reports first: neither waited on the other.
    await expect(resultPromise).resolves.toMatchObject([
      { targetId: 'target-2', result: { ok: true } },
      { targetId: 'target-1', result: { ok: true } }
    ])
  })

  it('retries once when a reset relay reports a lower revision than the cached base', async () => {
    const resetTarget: SshTarget = {
      id: 'target-reset',
      label: 'Reset Target',
      host: 'reset.example.com',
      port: 22,
      username: 'alice'
    }
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => [resetTarget]
    })
    getRepoMock.mockImplementation((repoId: string) =>
      repoId === 'repo-reset'
        ? ({
            id: 'repo-reset',
            path: '/remote/repo',
            displayName: 'Repo',
            badgeColor: 'blue',
            addedAt: 1,
            connectionId: 'target-reset'
          } as never)
        : undefined
    )

    const patchBaseRevisions: number[] = []
    const request = vi
      .fn()
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'workspace.get') {
          return snapshot(
            {
              activeWorktreePath: '/previous',
              activeTabId: null,
              tabsByWorktreePath: {},
              terminalLayoutsByTabId: {}
            },
            7
          )
        }
        if (method === 'workspace.patch') {
          patchBaseRevisions.push(params.baseRevision as number)
          if (patchBaseRevisions.length === 1) {
            return {
              ok: false,
              reason: 'stale-revision',
              snapshot: snapshot(
                {
                  activeWorktreePath: null,
                  activeTabId: null,
                  tabsByWorktreePath: {},
                  terminalLayoutsByTabId: {}
                },
                0
              )
            }
          }
          return {
            ok: true,
            snapshot: snapshot(patchSession(params), 1)
          }
        }
        throw new Error(`Unexpected method ${method}`)
      })
    muxByTargetId.set('target-reset', { request })
    const observationToken = observeSnapshot(
      'target-reset',
      snapshot(
        {
          activeWorktreePath: '/previous',
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        },
        7
      )
    )

    driver.agree('target-reset', { revision: 7, hostObservationToken: observationToken })
    driver.write(sessionWithTab('repo-reset::/remote/workspace', 'tab-reset'))
    await expect(driver.nextPushes()).resolves.toMatchObject([
      { targetId: 'target-reset', result: { ok: true } }
    ])
    expect(patchBaseRevisions).toEqual([7, 0])
  })

  it('does not retry stale writes when the relay reports a newer revision', async () => {
    const newerTarget: SshTarget = {
      id: 'target-newer',
      label: 'Newer Target',
      host: 'newer.example.com',
      port: 22,
      username: 'alice'
    }
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => [newerTarget]
    })
    getRepoMock.mockImplementation((repoId: string) =>
      repoId === 'repo-newer'
        ? ({
            id: 'repo-newer',
            path: '/remote/repo',
            displayName: 'Repo',
            badgeColor: 'blue',
            addedAt: 1,
            connectionId: 'target-newer'
          } as never)
        : undefined
    )

    const patchBaseRevisions: number[] = []
    const request = vi
      .fn()
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'workspace.get') {
          return snapshot(
            {
              activeWorktreePath: '/previous',
              activeTabId: null,
              tabsByWorktreePath: {},
              terminalLayoutsByTabId: {}
            },
            7
          )
        }
        if (method === 'workspace.patch') {
          patchBaseRevisions.push(params.baseRevision as number)
          return {
            ok: false,
            reason: 'stale-revision',
            snapshot: snapshot(
              {
                activeWorktreePath: '/other-device',
                activeTabId: null,
                tabsByWorktreePath: {},
                terminalLayoutsByTabId: {}
              },
              8
            )
          }
        }
        throw new Error(`Unexpected method ${method}`)
      })
    muxByTargetId.set('target-newer', { request })
    const observationToken = observeSnapshot(
      'target-newer',
      snapshot(
        {
          activeWorktreePath: '/previous',
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        },
        7
      )
    )

    driver.agree('target-newer', { revision: 7, hostObservationToken: observationToken })
    driver.write(sessionWithTab('repo-newer::/remote/workspace', 'tab-local'))
    await expect(driver.nextPushes()).resolves.toMatchObject([
      { targetId: 'target-newer', result: { ok: false, reason: 'stale-revision' } }
    ])
    expect(patchBaseRevisions).toEqual([7])
  })
})
