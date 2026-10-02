import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWorktreeMock,
  getActiveMultiplexerMock,
  getSshGitProviderMock,
  gitExecFileAsyncMock,
  listWorktreesMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'

const { trackMock, probeHookMock } = vi.hoisted(() => ({
  trackMock: vi.fn<(name: string, props: Record<string, unknown>) => void>(),
  probeHookMock: vi.fn()
}))

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
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    await importOriginal<Record<string, unknown>>()
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

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../git/post-checkout-hook-presence', () => ({
  probePostCheckoutHookPresence: probeHookMock
}))

function makeRepo(fields: Record<string, unknown>) {
  return {
    id: 'repo-1',
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    worktreeBaseRef: 'origin/main',
    ...fields
  }
}

function useRepo(repo: ReturnType<typeof makeRepo>): void {
  store.getRepos.mockReturnValue([repo])
  store.getRepo.mockReturnValue(repo)
  store.setWorktreeMeta.mockImplementation((_worktreeId: string, meta: unknown) => meta)
  getActiveMultiplexerMock.mockReturnValue({
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn()
  })
}

function useLocalListing(): void {
  listWorktreesMock.mockResolvedValue([
    { path: '/workspace/repo', head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
    { path: '/workspace/wt', head: 'abc123', branch: 'wt', isBare: false, isMainWorktree: false }
  ])
}

function trackedEvent(name: string): Record<string, unknown> | undefined {
  const call = trackMock.mock.calls.find(([eventName]) => eventName === name)
  return call?.[1]
}

function gitWorkCallCount(): number {
  return (
    gitExecFileAsyncMock.mock.calls.length +
    addWorktreeMock.mock.calls.length +
    listWorktreesMock.mock.calls.length
  )
}

describe('worktrees:create event timing fields', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
    trackMock.mockReset()
    probeHookMock.mockReset()
  })

  it('sends timing after the create returns, without any further git work', async () => {
    useRepo(makeRepo({}))
    useLocalListing()
    let resolveProbe: (value: string) => void = () => {}
    probeHookMock.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve
      })
    )

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })

    // The create already answered; the hook probe has not, so the event is not sent yet.
    expect(trackedEvent('workspace_created')).toBeUndefined()
    const gitCallsAtReturn = gitWorkCallCount()

    resolveProbe('present')
    await vi.waitFor(() => expect(trackedEvent('workspace_created')).toBeDefined())

    expect(gitWorkCallCount()).toBe(gitCallsAtReturn)
    expect(probeHookMock).toHaveBeenCalledWith('/workspace/repo')
    const props = trackedEvent('workspace_created')
    expect(props).toMatchObject({
      source: 'unknown',
      from_existing_branch: false,
      execution_host: 'local',
      worktree_count_bucket: '2-5',
      concurrent_creates: 0,
      post_checkout_hook: 'present'
    })
    expect(typeof props?.total_ms).toBe('number')
    expect(typeof props?.git_worktree_add_ms).toBe('number')
    expect(props).toHaveProperty('prepared_checkout')
    // Nothing that names the repo, the branch or a path rides along.
    expect(JSON.stringify(props)).not.toMatch(/workspace|wt|repo-1/)
  })

  it('records an SSH create without probing the remote for hooks', async () => {
    useRepo(makeRepo({ path: '/remote/repo', executionHostId: 'ssh:target-a' }))
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'show-ref') {
          throw Object.assign(new Error('missing exact ref'), { code: 1 })
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-wt',
          head: 'abc',
          branch: 'refs/heads/wt',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    getSshGitProviderMock.mockImplementation((connectionId: string) =>
      connectionId === 'target-a' ? provider : undefined
    )

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    await vi.waitFor(() => expect(trackedEvent('workspace_created')).toBeDefined())

    expect(probeHookMock).not.toHaveBeenCalled()
    const props = trackedEvent('workspace_created')
    expect(props).toMatchObject({ execution_host: 'ssh', worktree_count_bucket: '1' })
    expect(props).not.toHaveProperty('post_checkout_hook')
    expect(props).not.toHaveProperty('prepared_checkout')
  })

  it('names the phase a failed create died in', async () => {
    useRepo(makeRepo({}))
    useLocalListing()
    addWorktreeMock.mockRejectedValue(new Error('fatal: could not create work tree dir'))

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow()

    const props = trackedEvent('workspace_create_failed')
    expect(props).toMatchObject({
      failed_phase: 'git_worktree_add',
      execution_host: 'local',
      concurrent_creates: 0
    })
    expect(typeof props?.total_ms).toBe('number')
    expect(JSON.stringify(props)).not.toMatch(/fatal|work tree/)
  })
})
