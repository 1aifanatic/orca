import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeRemovalOutcome } from '../shared/worktree/removal-outcome'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  assertNoPendingWorktreeRemovalConflict,
  isWorktreeRemovalPending,
  projectPendingWorktreeRemovals,
  removesInBackground,
  startBackgroundWorktreeRemoval
} from './worktree-background-removal'

const removal = {
  worktreeId: 'repo-1::/work/feature',
  repoId: 'repo-1',
  repoPath: '/work/repo',
  worktreePath: '/work/feature',
  branch: 'feature'
}
const catalogVersion = { epoch: 'e', sequence: 7 }

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

  it('accepts before Git finishes and publishes the outcome after the row leaves the table', async () => {
    const git = deferred<{ preservedBranch: { branchName: string; head: string } }>()
    const published: { outcome?: WorktreeRemovalOutcome; pendingAtPublish: boolean }[] = []
    startBackgroundWorktreeRemoval({
      removal,
      run: () => git.promise,
      catalogVersion: () => catalogVersion,
      publish: (outcome) =>
        published.push({ outcome, pendingAtPublish: isWorktreeRemovalPending(removal.worktreeId) })
    })

    expect(isWorktreeRemovalPending(removal.worktreeId)).toBe(true)
    expect(published).toEqual([{ outcome: undefined, pendingAtPublish: true }])

    git.resolve({ preservedBranch: { branchName: 'feature', head: 'abc' } })
    await _settlePendingWorktreeRemovalsForTests()

    expect(isWorktreeRemovalPending(removal.worktreeId)).toBe(false)
    // A refetch the outcome triggers must not see the row as still removing.
    expect(published[1]).toEqual({
      outcome: {
        worktreeId: removal.worktreeId,
        status: 'removed',
        preservedBranch: { branchName: 'feature', head: 'abc' },
        catalogVersion
      },
      pendingAtPublish: false
    })
  })

  it('publishes a failure and clears the row so a retry starts over', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const publish = vi.fn()
    startBackgroundWorktreeRemoval({
      removal,
      run: async () => {
        throw new Error('Failed to delete worktree at /work/feature. Permission denied')
      },
      catalogVersion: () => catalogVersion,
      publish
    })
    await _settlePendingWorktreeRemovalsForTests()

    expect(isWorktreeRemovalPending(removal.worktreeId)).toBe(false)
    expect(publish).toHaveBeenLastCalledWith({
      worktreeId: removal.worktreeId,
      status: 'failed',
      error: 'Failed to delete worktree at /work/feature. Permission denied'
    })
  })

  it('keeps the table consistent when publishing throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    startBackgroundWorktreeRemoval({
      removal,
      run: async () => ({}),
      catalogVersion: () => catalogVersion,
      publish: () => {
        throw new Error('window gone')
      }
    })
    await _settlePendingWorktreeRemovalsForTests()
    expect(isWorktreeRemovalPending(removal.worktreeId)).toBe(false)
  })

  it('refuses a create at the same path or branch while Git deletes', async () => {
    const git = deferred<Record<string, never>>()
    startBackgroundWorktreeRemoval({
      removal,
      run: () => git.promise,
      catalogVersion: () => catalogVersion,
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
    startBackgroundWorktreeRemoval({
      removal,
      run: () => new Promise(() => {}),
      catalogVersion: () => catalogVersion,
      publish: () => {}
    })
    expect(isWorktreeRemovalPending(removal.worktreeId, 'local')).toBe(true)
    expect(isWorktreeRemovalPending(removal.worktreeId, 'ssh:box')).toBe(false)
  })

  it('marks rows for clients that read the marker and omits them for clients that do not', () => {
    startBackgroundWorktreeRemoval({
      removal,
      run: () => new Promise(() => {}),
      catalogVersion: () => catalogVersion,
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
    const rows = [{ id: removal.worktreeId }]
    expect(projectPendingWorktreeRemovals(rows, (row) => row.id, false)).toBe(rows)
  })
})
