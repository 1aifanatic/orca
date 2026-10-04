// A delete that fails after Git dropped the checkout's registration: the leftover stays listed with
// the error until Delete retries it, the checkout disappears, or its repo leaves Orca. Git is mocked
// here so this runs on every platform; the real-Git version is in
// runtime/runtime-failed-local-worktree-removal.test.ts.
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { listWorktreesStrict } from './git/worktree'
import { beginTerminalInstall } from './ipc/watcher-removal-gate'
import { registerWorktreeChangeInvalidator } from './ipc/worktree-change-invalidators'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
  retryFailedWorktreeRemoval,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from './worktree-background-removal'
import {
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  withUnregisteredRemovalCheckouts
} from './worktree-removal-listing'
import { readWorktreeRemovalRecords, writeWorktreeRemovalRecords } from './worktree-removal-records'
import { readCheckoutDirectoryIdentity } from './worktree-checkout-identity'
import { failedWorktreeRemovals, setUnfinishedWorktreeRemovalHost } from './worktree-removal-table'
import { loadWorktreeRemovalRecordsForStore } from './startup/worktree-removal-records-load'

vi.mock('./git/worktree', () => ({ listWorktreesStrict: vi.fn(async () => []) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

const GIT_ERROR = "error: failed to delete 'node_modules/a/LICENSE': Operation not permitted"
let directory = ''
let checkout = ''
let worktreeId = ''
const mainWorktree: GitWorktreeInfo = {
  path: '/work/repo',
  head: 'abc',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-failed-removal-')))
  checkout = join(directory, 'feature')
  worktreeId = `repo-1::${checkout}`
  // What Git left: part of the checkout, `.git` already deleted.
  await mkdir(join(checkout, 'node_modules', 'a'), { recursive: true })
  await writeFile(join(checkout, 'node_modules', 'a', 'LICENSE'), 'MIT\n')
  await mkdir(join(directory, 'profile'))
  await loadWorktreeRemovalRecords(join(directory, 'profile'))
  vi.mocked(listWorktreesStrict).mockResolvedValue([mainWorktree])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  setUnfinishedWorktreeRemovalHost(null)
  _resetPendingWorktreeRemovalsForTests()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

async function startFailingRemoval(): Promise<unknown> {
  return startBackgroundWorktreeRemoval({
    removal: {
      worktreeId,
      repoId: 'repo-1',
      repoPath: '/work/repo',
      worktree: { path: checkout, branch: 'refs/heads/feature', head: 'abc' },
      // As acceptance does: the directory the later retry may delete.
      checkoutIdentity: await readCheckoutDirectoryIdentity(checkout),
      deleteBranch: true,
      force: true
    },
    run: async () => {
      throw new Error(GIT_ERROR)
    },
    publish: () => {}
  })
}

async function failRemoval(): Promise<void> {
  await expect(startFailingRemoval()).rejects.toThrow(GIT_ERROR)
  await _settlePendingWorktreeRemovalsForTests()
}

async function listRows(): Promise<GitWorktreeInfo[]> {
  return withUnregisteredRemovalCheckouts('repo-1', [mainWorktree])
}

const leftoverRow = (): GitWorktreeInfo => ({
  path: checkout,
  head: 'abc',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false,
  removalError: GIT_ERROR
})

describe('a delete that fails after Git dropped the registration', () => {
  it('keeps the leftover listed with the error, recorded on disk, and not pending', async () => {
    await failRemoval()

    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
    const [record] = await readWorktreeRemovalRecords(join(directory, 'profile'))
    expect(record).toMatchObject({ worktreeId, failure: { message: GIT_ERROR } })
    expect(waitForPendingWorktreeRemoval(worktreeId)).toBeUndefined()
    // Not marked removing and not left out for older clients: it is a row they can delete again.
    const rows: { id: string; hostId?: undefined }[] = [{ id: worktreeId }]
    expect(
      projectPendingWorktreeRemovals(
        rows,
        (row) => row.id,
        false,
        snapshotPendingWorktreeRemovals()
      )
    ).toEqual(rows)
    // Nothing fences the leftover: a failed delete must not block terminals indefinitely.
    beginTerminalInstall(checkout)()
  })

  it('invalidates cached listings, which still hold the registration Git dropped', async () => {
    const invalidated = vi.fn()
    const unregister = registerWorktreeChangeInvalidator(invalidated)
    await failRemoval()
    unregister()

    expect(invalidated).toHaveBeenCalledWith('repo-1')
  })

  it('clears the record as before when Git still registers the checkout', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      mainWorktree,
      { ...leftoverRow(), removalError: undefined }
    ])
    await failRemoval()

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    // The workspace is still Git's, row and all.
    expect(endWorkspace).not.toHaveBeenCalled()
  })

  it('drops a failed delete Git could not be asked about once Git says it still registers the checkout', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    const checkoutRow = { ...leftoverRow(), removalError: undefined }
    vi.mocked(listWorktreesStrict).mockRejectedValueOnce(new Error('git worktree list timed out'))
    await failRemoval()
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toHaveLength(1)
    const listRegistered = () =>
      withUnregisteredRemovalCheckouts('repo-1', [mainWorktree, checkoutRow])

    // A cached scan can still list a checkout Git dropped, so the rows alone never decide.
    expect(await listRegistered()).toEqual([mainWorktree, checkoutRow])
    vi.mocked(listWorktreesStrict).mockRejectedValueOnce(new Error('git worktree list timed out'))
    expect(await listRegistered()).toEqual([mainWorktree, checkoutRow])
    expect(failedWorktreeRemovals.has(worktreeId)).toBe(true)
    expect(endWorkspace).not.toHaveBeenCalled()

    vi.mocked(listWorktreesStrict).mockResolvedValue([mainWorktree, checkoutRow])
    expect(await listRegistered()).toEqual([mainWorktree, checkoutRow])
    expect(failedWorktreeRemovals.has(worktreeId)).toBe(false)
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
    // The workspace is still Git's.
    expect(endWorkspace).not.toHaveBeenCalled()
  })

  it('clears the record as before when the checkout is gone', async () => {
    await rm(checkout, { recursive: true })
    await failRemoval()

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
  })

  it('never retries it on its own, at startup or when interrupted removals resume', async () => {
    await failRemoval()
    _resetPendingWorktreeRemovalsForTests()
    await loadWorktreeRemovalRecords(join(directory, 'profile'))
    const jobFor = vi.fn()

    resumeInterruptedWorktreeRemovals(jobFor)

    expect(jobFor).not.toHaveBeenCalled()
    expect(waitForPendingWorktreeRemoval(worktreeId)).toBeUndefined()
    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
    beginTerminalInstall(checkout)()
  })

  it('runs the recorded removal again on Delete and clears the record once it succeeds', async () => {
    await failRemoval()
    const publish = vi.fn()
    const run = vi.fn(async () => {
      // The retry shows as removing while it runs.
      expect(await listRows()).toEqual([
        mainWorktree,
        { ...leftoverRow(), removalError: undefined }
      ])
      await rm(checkout, { recursive: true })
      return {}
    })

    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', (record) => {
      // The user's first choices, without the failure.
      expect(record).toMatchObject({ deleteBranch: true, force: true })
      expect(record).not.toHaveProperty('failure')
      return { run, publish }
    })

    // A second window's Delete joins the same run.
    expect(waitForPendingWorktreeRemoval(worktreeId)).toBe(retried)
    await expect(retried).resolves.toEqual({})
    await _settlePendingWorktreeRemovalsForTests()
    expect(run).toHaveBeenCalledTimes(1)
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    expect(await listRows()).toEqual([mainWorktree])
    expect(retryFailedWorktreeRemoval(worktreeId, 'local', vi.fn())).toBeUndefined()
  })

  it('ends the workspace when a retry finds a folder the user put at the path', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    await failRemoval()
    await rm(checkout, { recursive: true })
    await mkdir(checkout)
    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', () => ({
      run: async () => {
        throw new Error('not the folder Orca started deleting')
      },
      publish: () => {}
    }))

    await expect(retried).rejects.toThrow('not the folder')
    // Already by the reply, so a Delete sent after it finds nothing to delete at the path.
    expect(endWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ worktreeId }))
    await _settlePendingWorktreeRemovalsForTests()
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
  })

  it('keeps a refused retry for the next listing while Git cannot say what is at the path', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    await failRemoval()
    await rm(checkout, { recursive: true })
    await mkdir(checkout)
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce([mainWorktree])
      .mockRejectedValueOnce(new Error('git worktree list timed out'))
    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', () => ({
      run: async () => {
        throw new Error('not the folder Orca started deleting')
      },
      publish: () => {}
    }))

    await expect(retried).rejects.toThrow('not the folder')
    await _settlePendingWorktreeRemovalsForTests()
    expect(endWorkspace).not.toHaveBeenCalled()
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toMatchObject([
      { worktreeId, failure: { message: 'not the folder Orca started deleting' } }
    ])

    expect(await listRows()).toEqual([mainWorktree])
    expect(endWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ worktreeId }))
  })

  it('keeps the row, and its workspace, while the leftover cannot be read', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    await failRemoval()
    // A read error, like a briefly unreachable share: once to find it, once to identify it.
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    vi.mocked(lstat).mockRejectedValueOnce(denied).mockRejectedValueOnce(denied)

    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
    expect(endWorkspace).not.toHaveBeenCalled()
    expect(await listRows()).toEqual([mainWorktree, leftoverRow()])
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toHaveLength(1)
  })

  it('keeps the row with the new error when the retry fails the same way', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    await failRemoval()
    const retried = retryFailedWorktreeRemoval(worktreeId, undefined, () => ({
      run: async () => {
        throw new Error('still not permitted')
      },
      publish: () => {}
    }))

    await expect(retried).rejects.toThrow('still not permitted')
    await _settlePendingWorktreeRemovalsForTests()
    expect(await listRows()).toEqual([
      mainWorktree,
      { ...leftoverRow(), removalError: 'still not permitted' }
    ])
    expect(endWorkspace).not.toHaveBeenCalled()
  })

  it('does not run the recorded removal once Git registers a checkout at the path again', async () => {
    await failRemoval()
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      mainWorktree,
      { ...leftoverRow(), removalError: undefined }
    ])
    const run = vi.fn(async () => ({}))

    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', () => ({
      run,
      publish: () => {}
    }))

    await expect(retried).rejects.toThrow(/A different checkout is now at/)
    await _settlePendingWorktreeRemovalsForTests()
    expect(run).not.toHaveBeenCalled()
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
  })

  it('is not retried for another host', async () => {
    await failRemoval()

    expect(retryFailedWorktreeRemoval(worktreeId, 'ssh:box', vi.fn())).toBeUndefined()
  })

  it('ends at the next listing once the checkout is deleted outside Orca', async () => {
    await failRemoval()
    await rm(checkout, { recursive: true })

    expect(await listRows()).toEqual([mainWorktree])
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
  })

  it('ends with its workspace at the first listing after a restart, once the checkout is deleted outside Orca', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    await failRemoval()
    _resetPendingWorktreeRemovalsForTests()
    await rm(checkout, { recursive: true })

    await loadWorktreeRemovalRecords(join(directory, 'profile'))
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toHaveLength(1)

    expect(await listRows()).toEqual([mainWorktree])
    expect(endWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ worktreeId }))
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
  })

  it('ends at startup once its repo is removed from Orca, leaving the files', async () => {
    await failRemoval()
    _resetPendingWorktreeRemovalsForTests()

    // Only an SSH copy of the project is left under the same repo id.
    await loadWorktreeRemovalRecordsForStore({
      getProfileStorageDirectory: () => join(directory, 'profile'),
      getRepos: () => [{ id: 'repo-1', connectionId: 'box', executionHostId: null }]
    })

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    expect(retryFailedWorktreeRemoval(worktreeId, 'local', vi.fn())).toBeUndefined()
    expect(await readdir(checkout)).toEqual(['node_modules'])
  })

  it('is kept at startup while the repo’s local copy is still in Orca', async () => {
    await failRemoval()
    _resetPendingWorktreeRemovalsForTests()

    await loadWorktreeRemovalRecordsForStore({
      getProfileStorageDirectory: () => join(directory, 'profile'),
      getRepos: () => [
        { id: 'repo-1', connectionId: 'box', executionHostId: null },
        { id: 'repo-1', connectionId: null, executionHostId: null }
      ]
    })

    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toHaveLength(1)
    expect(await listRows()).toHaveLength(2)
  })

  it('ends at the next listing once a different checkout takes the path', async () => {
    await failRemoval()
    await mkdir(join(checkout, '.git'))

    expect(await listRows()).toEqual([mainWorktree])
    expect(retryFailedWorktreeRemoval(worktreeId, 'local', vi.fn())).toBeUndefined()
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
  })

  it('ends, leaving the files, once the user puts an ordinary folder at the path', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    await failRemoval()
    // No `.git`, like the leftover: only the directory's identity tells them apart.
    await rm(checkout, { recursive: true })
    await mkdir(checkout)
    await writeFile(join(checkout, 'notes.txt'), 'mine\n')

    expect(await listRows()).toEqual([mainWorktree])
    // With its workspace, whose creation metadata would let a later Delete take the folder.
    expect(endWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ worktreeId }))
    expect(retryFailedWorktreeRemoval(worktreeId, 'local', vi.fn())).toBeUndefined()
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
    expect(existsSync(join(checkout, 'notes.txt'))).toBe(true)
  })

  it('keeps the failed delete for the next listing while Git cannot say whether it registers the path', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    await failRemoval()
    await rm(checkout, { recursive: true })
    await mkdir(checkout)
    vi.mocked(listWorktreesStrict).mockRejectedValueOnce(new Error('git worktree list timed out'))

    expect(await listRows()).toEqual([mainWorktree])
    expect(endWorkspace).not.toHaveBeenCalled()
    expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toHaveLength(1)

    expect(await listRows()).toEqual([mainWorktree])
    expect(endWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ worktreeId }))
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
  })

  it('still lets a Delete retry it while a listing asks Git whether to end it', async () => {
    const endWorkspace = vi.fn()
    setUnfinishedWorktreeRemovalHost(endWorkspace)
    await failRemoval()
    await rm(checkout, { recursive: true })
    await mkdir(checkout)
    let answerGit!: () => void
    let askedGit!: () => void
    const listingAskedGit = new Promise<void>((resolve) => (askedGit = resolve))
    vi.mocked(listWorktreesStrict).mockImplementationOnce(() => {
      askedGit()
      return new Promise((resolve) => (answerGit = () => resolve([mainWorktree])))
    })

    const listing = listRows()
    await listingAskedGit
    const retried = retryFailedWorktreeRemoval(worktreeId, 'local', () => ({
      run: async () => {
        throw new Error('not the folder Orca started deleting')
      },
      publish: () => {}
    }))
    await expect(retried).rejects.toThrow('not the folder')
    answerGit()

    expect(await listing).toEqual([mainWorktree])
    expect(endWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ worktreeId }))
  })

  it('ends, leaving the files, for a failed delete an older build recorded without an identity', async () => {
    await writeWorktreeRemovalRecords(join(directory, 'profile'), () => [
      {
        worktreeId,
        repoId: 'repo-1',
        repoPath: '/work/repo',
        worktreePath: checkout,
        branch: 'feature',
        head: 'abc',
        deleteBranch: true,
        force: true,
        requestedAt: 1,
        failure: { message: GIT_ERROR, failedAt: 2 }
      }
    ])
    await loadWorktreeRemovalRecords(join(directory, 'profile'))

    // Nothing proves the folder is still the one that delete accepted.
    expect(await listRows()).toEqual([mainWorktree])
    expect(retryFailedWorktreeRemoval(worktreeId, 'local', vi.fn())).toBeUndefined()
    await vi.waitFor(async () =>
      expect(await readWorktreeRemovalRecords(join(directory, 'profile'))).toEqual([])
    )
    expect(await readdir(checkout)).toEqual(['node_modules'])
  })
})
