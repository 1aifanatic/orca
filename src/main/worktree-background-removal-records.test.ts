import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeRemovalOutcome } from '../shared/worktree/removal-outcome'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  isWorktreeRemovalPending,
  loadWorktreeRemovalRecords,
  projectPendingWorktreeRemovals,
  resumeInterruptedWorktreeRemovals,
  startBackgroundWorktreeRemoval,
  stopBackgroundWorktreeRemovals
} from './worktree-background-removal'
import { readWorktreeRemovalRecords, worktreeRemovalRecordsFile } from './worktree-removal-records'

const removal = {
  worktreeId: 'repo-1::/work/feature',
  repoId: 'repo-1',
  repoPath: '/work/repo',
  worktree: { path: '/work/feature', branch: 'refs/heads/feature', head: 'abc' },
  deleteBranch: true,
  force: false
}
const catalogVersion = { epoch: 'e', sequence: 1 }
let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-worktree-removal-records-'))
  await loadWorktreeRemovalRecords(directory)
})

afterEach(async () => {
  _resetPendingWorktreeRemovalsForTests()
  await rm(directory, { recursive: true, force: true })
})

/** A delete Git never finishes on its own, like one a quit or crash cuts short. */
function interruptedJob(): {
  run: (stopSignal: AbortSignal) => Promise<never>
  catalogVersion: () => typeof catalogVersion
  publish: (outcome?: WorktreeRemovalOutcome) => void
  started: () => boolean
  stopped: () => boolean
} {
  let started = false
  let stopped = false
  return {
    run: (stopSignal) =>
      new Promise((_resolve, reject) => {
        started = true
        stopSignal.addEventListener('abort', () => {
          stopped = true
          reject(new Error('The operation was aborted.'))
        })
      }),
    catalogVersion: () => catalogVersion,
    publish: vi.fn(),
    started: () => started,
    stopped: () => stopped
  }
}

describe('durable worktree removal records', () => {
  it('writes the record before Git starts and clears it once the delete succeeds', async () => {
    let recordedAtGitStart: unknown[] = []
    startBackgroundWorktreeRemoval({
      removal,
      run: async () => {
        recordedAtGitStart = await readWorktreeRemovalRecords(directory)
        return {}
      },
      catalogVersion: () => catalogVersion,
      publish: () => {}
    })
    await _settlePendingWorktreeRemovalsForTests()

    expect(recordedAtGitStart).toEqual([
      {
        worktreeId: removal.worktreeId,
        repoId: 'repo-1',
        repoPath: '/work/repo',
        worktreePath: '/work/feature',
        branch: 'feature',
        head: 'abc',
        deleteBranch: true,
        force: false,
        requestedAt: expect.any(Number)
      }
    ])
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  })

  it('clears the record when the delete fails so the row returns live and retryable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const publish = vi.fn()
    startBackgroundWorktreeRemoval({
      removal,
      run: async () => {
        throw new Error('Permission denied')
      },
      catalogVersion: () => catalogVersion,
      publish
    })
    await _settlePendingWorktreeRemovalsForTests()

    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
    expect(isWorktreeRemovalPending(removal.worktreeId)).toBe(false)
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Permission denied' })
    )
  })

  it('stops Git on quit without waiting and keeps the record for the next start', async () => {
    const job = interruptedJob()
    startBackgroundWorktreeRemoval({ removal, ...job })
    await vi.waitFor(() => expect(job.started()).toBe(true))

    expect(stopBackgroundWorktreeRemovals()).toBeUndefined()
    expect(job.stopped()).toBe(true)
    await _settlePendingWorktreeRemovalsForTests()

    expect(await readWorktreeRemovalRecords(directory)).toHaveLength(1)
    // Only the start was published: a stopped delete is neither removed nor failed.
    expect(job.publish).toHaveBeenCalledTimes(1)
  })

  it('marks the row as removing after a restart and finishes it with the same job', async () => {
    const job = interruptedJob()
    startBackgroundWorktreeRemoval({ removal, ...job })
    await vi.waitFor(() => expect(job.started()).toBe(true))
    stopBackgroundWorktreeRemovals()
    await _settlePendingWorktreeRemovalsForTests()

    // Restart: nothing in memory, only the file.
    _resetPendingWorktreeRemovalsForTests()
    expect(isWorktreeRemovalPending(removal.worktreeId)).toBe(false)
    await loadWorktreeRemovalRecords(directory)
    const rows: { id: string; hostId?: undefined }[] = [
      { id: removal.worktreeId },
      { id: 'repo-1::/work/other' }
    ]
    expect(projectPendingWorktreeRemovals(rows, (row) => row.id, true)).toEqual([
      { id: removal.worktreeId, removing: true },
      { id: 'repo-1::/work/other' }
    ])
    expect(projectPendingWorktreeRemovals(rows, (row) => row.id, false)).toEqual([
      { id: 'repo-1::/work/other' }
    ])

    const publish = vi.fn()
    const resumed: string[] = []
    resumeInterruptedWorktreeRemovals((record) => ({
      run: async () => {
        resumed.push(`${record.worktreePath} ${record.branch} ${record.deleteBranch}`)
        return {}
      },
      catalogVersion: () => catalogVersion,
      publish
    }))
    await _settlePendingWorktreeRemovalsForTests()

    expect(resumed).toEqual(['/work/feature feature true'])
    expect(isWorktreeRemovalPending(removal.worktreeId)).toBe(false)
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: removal.worktreeId, status: 'removed' })
    )
  })

  it('does not start a second job for a removal that is still running', async () => {
    startBackgroundWorktreeRemoval({ removal, ...interruptedJob() })
    const jobFor = vi.fn()
    resumeInterruptedWorktreeRemovals(jobFor)
    expect(jobFor).not.toHaveBeenCalled()
    stopBackgroundWorktreeRemovals()
    await _settlePendingWorktreeRemovalsForTests()
  })

  it('reads back only well-formed records from the file', async () => {
    const valid = {
      worktreeId: 'repo-1::/work/a',
      repoId: 'repo-1',
      repoPath: '/work/repo',
      worktreePath: '/work/a',
      branch: '',
      head: '',
      deleteBranch: false,
      force: true,
      requestedAt: 5
    }
    await writeFile(
      worktreeRemovalRecordsFile(directory),
      JSON.stringify({ version: 1, removals: [valid, { worktreeId: 'x' }, null] })
    )
    expect(await readWorktreeRemovalRecords(directory)).toEqual([valid])

    await writeFile(worktreeRemovalRecordsFile(directory), '{not json')
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  })
})
