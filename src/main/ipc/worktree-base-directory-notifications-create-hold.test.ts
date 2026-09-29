import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HeadIdentityRefreshModule from './worktree-head-identity-refresh'

const notifyCatalogMock = vi.hoisted(() => vi.fn())
const notifyStatusMock = vi.hoisted(() => vi.fn())

vi.mock('./watched-worktree-catalog-notification', () => ({
  notifyWatchedWorktreeCatalogChanged: notifyCatalogMock
}))
vi.mock('./worktree-remote', () => ({
  notifyWorktreeGitStatusMetadataChanged: notifyStatusMock
}))
vi.mock('./worktree-head-identity-refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof HeadIdentityRefreshModule>()),
  refreshWorktreeHeadIdentities: vi.fn(async () => undefined)
}))

import {
  scheduleWorktreeBaseNotification,
  type WorktreeBaseNotificationWatch
} from './worktree-base-directory-notifications'
import { EMPTY_HEAD_IDENTITY_SCOPE } from './worktree-head-identity-scope'
import { createWorktreeHeadIdentityRefreshState } from './worktree-head-identity-refresh'
import {
  _resetLocalWorktreeCreateActivityForTests,
  holdLocalWorktreeCreate,
  LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS
} from '../git/local-worktree-create-activity'

function watch(connectionId?: string): WorktreeBaseNotificationWatch {
  return {
    key: 'watch',
    kind: 'git-common',
    path: '/repo/.git',
    ...(connectionId ? { connectionId } : {}),
    repos: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The notifier only calls isDestroyed() on the window.
    mainWindow: { isDestroyed: () => false } as WorktreeBaseNotificationWatch['mainWindow'],
    notifyTimer: null,
    pendingStructureRepoIds: new Set(),
    pendingGitStatusRepoIds: new Set(),
    pendingHeadIdentityRepoIds: new Set(),
    pendingHeadIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE,
    headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
    disposed: false
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  notifyCatalogMock.mockReset()
  notifyStatusMock.mockReset()
})

afterEach(() => {
  _resetLocalWorktreeCreateActivityForTests()
  vi.useRealTimers()
})

describe('worktree watcher notifications during a local create', () => {
  it('holds structural changes until the create settles, then delivers them once', async () => {
    const release = holdLocalWorktreeCreate()
    const target = watch()
    scheduleWorktreeBaseNotification(target, { structureRepoIds: ['repo-1'] })
    await vi.advanceTimersByTimeAsync(300)
    scheduleWorktreeBaseNotification(target, { structureRepoIds: ['repo-1', 'repo-2'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyCatalogMock).not.toHaveBeenCalled()

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(notifyCatalogMock.mock.calls.map(([, repoId]) => repoId).sort()).toEqual([
      'repo-1',
      'repo-2'
    ])
  })

  it('delivers held changes at the deadline even if the create never settles', async () => {
    holdLocalWorktreeCreate()
    scheduleWorktreeBaseNotification(watch(), { structureRepoIds: ['repo-1'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyCatalogMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS)
    expect(notifyCatalogMock).toHaveBeenCalledOnce()
  })

  it('still sends status-only changes at once', async () => {
    holdLocalWorktreeCreate()
    scheduleWorktreeBaseNotification(watch(), { gitStatusRepoIds: ['repo-1'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyStatusMock).toHaveBeenCalledOnce()
  })

  it('never holds an SSH repo, whose Git runs on another machine', async () => {
    holdLocalWorktreeCreate()
    scheduleWorktreeBaseNotification(watch('conn-1'), { structureRepoIds: ['repo-1'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(notifyCatalogMock).toHaveBeenCalledOnce()
  })
})
