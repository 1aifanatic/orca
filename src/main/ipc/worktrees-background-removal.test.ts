import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWorktreeMock,
  handleMock,
  listWorktreesMock,
  removeWorktreeMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { mockKnownFeatureWorktree } from './worktrees-test-fixtures'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests
} from '../worktree-background-removal'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

type RawHandler = (event: unknown, args: unknown) => Promise<Record<string, unknown>>

// The harness waits for the outcome the way the renderer does; these tests read the raw reply.
function rawRemoveHandler(): RawHandler {
  const call = handleMock.mock.calls.findLast(([channel]) => channel === 'worktrees:remove')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ipcMain.handle's second argument is the registered handler.
  return call?.[1] as RawHandler
}

function blockGitRemove(): {
  release: (result?: RemoveWorktreeResult) => void
  fail: (error: Error) => void
} {
  let release!: (result?: RemoveWorktreeResult) => void
  let fail!: (error: Error) => void
  removeWorktreeMock.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        release = (result = {}) => resolve(result)
        fail = reject
      })
  )
  return {
    release: (result) => release(result),
    fail: (error) => fail(error)
  }
}

const featureId = 'repo-1::/workspace/feature-wt'

describe('worktrees:remove in the background', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
  })

  it('accepts before Git finishes and lists the row as removing until it does', async () => {
    const worktrees = mockKnownFeatureWorktree()
    const git = blockGitRemove()

    await expect(rawRemoveHandler()(null, { worktreeId: featureId })).resolves.toMatchObject({
      removing: true
    })
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(1))
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()

    const during = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      removing?: true
    }[]
    expect(during.find((row) => row.id === featureId)?.removing).toBe(true)
    expect(during.find((row) => row.id === 'repo-1::/workspace/repo')?.removing).toBeUndefined()

    listWorktreesMock.mockResolvedValue([worktrees[0]])
    git.release({ preservedBranch: { branchName: 'feature', head: 'feature' } })
    await _settlePendingWorktreeRemovalsForTests()

    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(featureId, 'local')
    expect(runtimeStub.removalOutcomes.get(featureId)).toMatchObject({
      status: 'removed',
      preservedBranch: { branchName: 'feature', head: 'feature' }
    })
    const after = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
    }[]
    expect(after.map((row) => row.id)).not.toContain(featureId)
  })

  it('publishes a failure after acceptance and lists the row normally again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockKnownFeatureWorktree()
    const git = blockGitRemove()

    await rawRemoveHandler()(null, { worktreeId: featureId })
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(1))
    git.fail(new Error('permission denied'))
    await _settlePendingWorktreeRemovalsForTests()

    expect(runtimeStub.removalOutcomes.get(featureId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('permission denied')
    })
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    const rows = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      removing?: true
    }[]
    expect(rows.find((row) => row.id === featureId)).toBeDefined()
    expect(rows.find((row) => row.id === featureId)?.removing).toBeUndefined()

    // A retry is a fresh removal, not a join onto the failed one.
    removeWorktreeMock.mockResolvedValue({})
    await expect(rawRemoveHandler()(null, { worktreeId: featureId })).resolves.toMatchObject({
      removing: true
    })
    await _settlePendingWorktreeRemovalsForTests()
    expect(removeWorktreeMock).toHaveBeenCalledTimes(2)
  })

  it('joins a repeat delete, with any options, onto the removal Git is running', async () => {
    mockKnownFeatureWorktree()
    const git = blockGitRemove()

    await rawRemoveHandler()(null, { worktreeId: featureId })
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(1))
    await expect(
      rawRemoveHandler()(null, { worktreeId: featureId, force: true, hostId: 'local' })
    ).resolves.toMatchObject({ removing: true })

    git.release()
    await _settlePendingWorktreeRemovalsForTests()
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1)
  })

  it('gives a create with the same name the next free name while the delete runs', async () => {
    mockKnownFeatureWorktree()
    blockGitRemove()
    await rawRemoveHandler()(null, { worktreeId: featureId })
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(1))

    addWorktreeMock.mockResolvedValue({})
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/feature-wt-2',
        head: 'abc',
        branch: 'feature-wt-2',
        isBare: false,
        isMainWorktree: false
      }
    ])
    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'feature-wt' })

    expect(addWorktreeMock).toHaveBeenCalledTimes(1)
    expect(addWorktreeMock.mock.calls[0]?.[1]).toBe('/workspace/feature-wt-2')
  })
})
