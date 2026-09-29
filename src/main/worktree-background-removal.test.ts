import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  assertNoPendingWorktreeRemovalConflict,
  finishAcceptedWorktreeRemoval,
  projectPendingWorktreeRemovals,
  removesInBackground,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from './worktree-background-removal'

const removal = {
  worktreeId: 'repo-1::/work/feature',
  repoId: 'repo-1',
  repoPath: '/work/repo',
  worktree: { path: '/work/feature', branch: 'refs/heads/feature', head: 'abc' },
  deleteBranch: true,
  force: false
}
const isPending = (hostId?: string): boolean =>
  waitForPendingWorktreeRemoval(removal.worktreeId, hostId) !== undefined

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('background worktree removal', () => {
  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
  })

  it('resolves with the delete result once Git finishes, after the row has left the table', async () => {
    const git = deferred<{ preservedBranch: { branchName: string; head: string } }>()
    const pendingAtPublish: boolean[] = []
    const result = startBackgroundWorktreeRemoval({
      removal,
      run: () => git.promise,
      publish: () => pendingAtPublish.push(isPending())
    })

    expect(isPending()).toBe(true)
    expect(pendingAtPublish).toEqual([true])

    git.resolve({ preservedBranch: { branchName: 'feature', head: 'abc' } })
    await expect(result).resolves.toEqual({
      preservedBranch: { branchName: 'feature', head: 'abc' }
    })
    await _settlePendingWorktreeRemovalsForTests()
    expect(isPending()).toBe(false)
    // A refetch the end notice triggers must not see the row as still removing.
    expect(pendingAtPublish).toEqual([true, false])
  })

  it('gives a request that joins a running delete that delete’s result', async () => {
    const git = deferred<{ preservedBranch: { branchName: string; head: string } }>()
    const run = vi.fn(() => git.promise)
    void startBackgroundWorktreeRemoval({ removal, run, publish: () => {} })

    const joined = finishAcceptedWorktreeRemoval(
      { removing: true, warning: 'hook skipped' },
      removal.worktreeId
    )
    git.resolve({ preservedBranch: { branchName: 'feature', head: 'abc' } })

    await expect(joined).resolves.toEqual({
      warning: 'hook skipped',
      preservedBranch: { branchName: 'feature', head: 'abc' }
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rejects with the delete error and clears the row so a retry starts over', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = startBackgroundWorktreeRemoval({
      removal,
      run: async () => {
        throw new Error('Failed to delete worktree at /work/feature. Permission denied')
      },
      publish: () => {}
    })
    await expect(result).rejects.toThrow('Permission denied')
    await _settlePendingWorktreeRemovalsForTests()
    expect(isPending()).toBe(false)
  })

  it('keeps the table consistent when publishing throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    void startBackgroundWorktreeRemoval({
      removal,
      run: async () => ({}),
      publish: () => {
        throw new Error('window gone')
      }
    })
    await _settlePendingWorktreeRemovalsForTests()
    expect(isPending()).toBe(false)
  })

  it('refuses a create at the same path or branch while Git deletes', async () => {
    const git = deferred<Record<string, never>>()
    void startBackgroundWorktreeRemoval({
      removal,
      run: () => git.promise,
      publish: () => {}
    })

    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', { worktreePath: '/work/feature' })
    ).toThrow('Cleanup is pending; try again shortly.')
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', { branch: 'refs/heads/feature' })
    ).toThrow('Cleanup is pending; try again shortly.')
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/other-repo', { branch: 'feature' })
    ).not.toThrow()
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', {
        worktreePath: '/work/feature-2',
        branch: 'feature-2'
      })
    ).not.toThrow()

    git.resolve({})
    await _settlePendingWorktreeRemovalsForTests()
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', { worktreePath: '/work/feature' })
    ).not.toThrow()
  })

  it('answers only for this host: a same-id row on an SSH host is not being removed here', () => {
    void startBackgroundWorktreeRemoval({
      removal,
      run: () => new Promise(() => {}),
      publish: () => {}
    })
    expect(isPending('local')).toBe(true)
    expect(isPending('ssh:box')).toBe(false)
  })

  it('marks rows for clients that read the marker and omits them for clients that do not', () => {
    void startBackgroundWorktreeRemoval({
      removal,
      run: () => new Promise(() => {}),
      publish: () => {}
    })
    const rows = [
      { id: removal.worktreeId, hostId: 'local' as const },
      { id: 'repo-1::/work/other' },
      { id: removal.worktreeId, hostId: 'ssh:box' as const }
    ]

    expect(projectPendingWorktreeRemovals(rows, (row) => row.id, true)).toEqual([
      { id: removal.worktreeId, hostId: 'local', removing: true },
      { id: 'repo-1::/work/other' },
      { id: removal.worktreeId, hostId: 'ssh:box' }
    ])
    expect(projectPendingWorktreeRemovals(rows, (row) => row.id, false)).toEqual([
      { id: 'repo-1::/work/other' },
      { id: removal.worktreeId, hostId: 'ssh:box' }
    ])
  })

  it('keeps WSL checkouts on the inline delete', () => {
    expect(removesInBackground('/work/feature', {})).toBe(true)
    expect(removesInBackground('/home/me/feature', { wslDistro: 'Ubuntu' })).toBe(false)
  })

  it('returns listings untouched when nothing is being removed', () => {
    const rows: { id: string; hostId?: undefined }[] = [{ id: removal.worktreeId }]
    expect(projectPendingWorktreeRemovals(rows, (row) => row.id, false)).toBe(rows)
  })
})
