// A runtime Delete (paired desktop, web, mobile, CLI) on the leftover of a delete that failed after
// Git dropped the registration: the leftover is listed with its error and Delete runs the recorded
// removal again, instead of the leftover vanishing from every listing.
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  gitRunner,
  join,
  listWorktreesStrict,
  mkdir,
  mkdtemp,
  removeWorktree,
  rm,
  scanLocalRepoWorktreesForResolutionMock,
  tmpdir,
  writeFile
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  createStaleRuntimeWorktreeStore
} from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  retryFailedWorktreeRemoval
} from '../../worktree-background-removal'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords
} from '../../worktree-removal-records'
import { readCheckoutDirectoryIdentity } from '../../worktree-checkout-identity'

const FAILURE = "error: failed to delete 'node_modules/a/LICENSE': Operation not permitted"

describe('runtime Delete on a failed delete’s leftover', () => {
  let directory = ''
  let leftover = ''
  let leftoverId = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-failed-removal-')))
    leftover = join(directory, 'feature')
    leftoverId = `${TEST_REPO_ID}::${leftover}`
    await mkdir(join(leftover, 'node_modules'), { recursive: true })
    const checkoutIdentity = await readCheckoutDirectoryIdentity(leftover)
    await writeWorktreeRemovalRecords(directory, () => [
      {
        worktreeId: leftoverId,
        repoId: TEST_REPO_ID,
        repoPath: TEST_REPO_PATH,
        worktreePath: leftover,
        branch: 'feature',
        head: 'abc',
        deleteBranch: true,
        force: true,
        requestedAt: 1,
        checkoutIdentity,
        failure: { message: FAILURE, failedAt: 2 }
      }
    ])
    await loadWorktreeRemovalRecords(directory)
  })

  afterEach(async () => {
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    await rm(directory, { recursive: true, force: true })
  })

  it('lists the leftover with its error, though Git no longer does', async () => {
    const runtime = createWorktreeRemovalRuntime()

    const detected = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(detected.worktrees.find((row) => row.id === leftoverId)).toMatchObject({
      path: leftover,
      removalError: FAILURE
    })
  })

  it('runs the recorded removal again, answering a client that cannot wait on acceptance', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = createWorktreeRemovalRuntime()

    await expect(
      runtime.removeManagedWorktree(`id:${leftoverId}`, { waitForBackgroundRemoval: false })
    ).resolves.toEqual({ removing: true })
    await _settlePendingWorktreeRemovalsForTests()

    // Git has no registration left for it, so Orca deletes the leftover itself.
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(existsSync(leftover)).toBe(false)
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  })

  it('takes the normal delete once Git registers a checkout at the path again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A new checkout at the same path: the recorded choices were for the leftover, not for it.
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      {
        path: leftover,
        head: 'def',
        branch: 'refs/heads/other',
        isBare: false,
        isMainWorktree: false
      }
    ])
    vi.mocked(removeWorktree).mockResolvedValue({})
    const runtime = createWorktreeRemovalRuntime()

    await runtime.removeManagedWorktree(`id:${leftoverId}`, { waitForBackgroundRemoval: true })
    await _settlePendingWorktreeRemovalsForTests()

    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, leftover, false, expect.anything())
    expect(existsSync(join(leftover, 'node_modules'))).toBe(true)
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  })

  it('joins a retry another client started while this Delete listed Git', async () => {
    const otherClientsRetry = vi.fn(async () => ({}))
    vi.mocked(listWorktreesStrict).mockImplementationOnce(async () => {
      void retryFailedWorktreeRemoval(leftoverId, 'local', () => ({
        run: otherClientsRetry,
        publish: () => {}
      }))
      return []
    })
    const runtime = createWorktreeRemovalRuntime()

    await expect(
      runtime.removeManagedWorktree(`id:${leftoverId}`, { waitForBackgroundRemoval: true })
    ).resolves.toEqual({})

    expect(otherClientsRetry).toHaveBeenCalledTimes(1)
    // Only the joined retry ran: the leftover is still there because its stub deleted nothing.
    expect(existsSync(join(leftover, 'node_modules'))).toBe(true)
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('replies to a waiting client once the retry finishes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = createWorktreeRemovalRuntime()

    await expect(
      runtime.removeManagedWorktree(`id:${leftoverId}`, { waitForBackgroundRemoval: true })
    ).resolves.toEqual({})
    expect(existsSync(leftover)).toBe(false)
  })
})

describe('runtime listing straight after a delete fails partway', () => {
  let directory = ''
  let leftover = ''
  let leftoverId = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-failed-listing-')))
    leftover = join(directory, 'feature')
    leftoverId = `${TEST_REPO_ID}::${leftover}`
    await mkdir(join(leftover, 'node_modules'), { recursive: true })
    await loadWorktreeRemovalRecords(directory)
  })

  afterEach(async () => {
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it('shows the failed row with its error, not the scan cached before the delete', async () => {
    const registered = {
      path: leftover,
      head: 'abc',
      branch: 'refs/heads/feature',
      isBare: false,
      isMainWorktree: false
    }
    const gitLists = (worktrees: (typeof registered)[]): void => {
      vi.mocked(listWorktreesStrict).mockResolvedValue(worktrees)
      scanLocalRepoWorktreesForResolutionMock.mockResolvedValue({ ok: true, worktrees })
    }
    gitLists([registered])
    const runtime = createWorktreeRemovalRuntime()
    const listLeftover = async () =>
      (await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).worktrees.find(
        (row) => row.id === leftoverId
      )
    // Caches Git's registration for the 30 s scan TTL.
    expect(await listLeftover()).not.toHaveProperty('removalError')
    vi.mocked(removeWorktree).mockImplementation(async () => {
      // Git drops the registration, then fails on a file it cannot delete.
      gitLists([])
      throw new Error(FAILURE)
    })

    await expect(
      runtime.removeManagedWorktree(`id:${leftoverId}`, {
        force: true,
        waitForBackgroundRemoval: true
      })
    ).rejects.toThrow(/Operation not permitted/)
    await _settlePendingWorktreeRemovalsForTests()

    expect(await listLeftover()).toMatchObject({
      path: leftover,
      removalError: expect.stringMatching(/Operation not permitted/)
    })
  })
})

describe('runtime Delete after the user replaced a failed delete’s leftover', () => {
  let directory = ''
  let leftover = ''
  let leftoverId = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-replaced-leftover-')))
    leftover = join(directory, 'feature')
    leftoverId = `${TEST_REPO_ID}::${leftover}`
    await mkdir(join(leftover, 'node_modules'), { recursive: true })
    const checkoutIdentity = await readCheckoutDirectoryIdentity(leftover)
    await writeWorktreeRemovalRecords(directory, () => [
      {
        worktreeId: leftoverId,
        repoId: TEST_REPO_ID,
        repoPath: TEST_REPO_PATH,
        worktreePath: leftover,
        branch: 'feature',
        head: 'abc',
        deleteBranch: true,
        force: true,
        requestedAt: 1,
        checkoutIdentity,
        failure: { message: FAILURE, failedAt: 2 }
      }
    ])
    await loadWorktreeRemovalRecords(directory)
    vi.mocked(listWorktreesStrict).mockResolvedValue([])
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'status') {
        throw new Error('fatal: not a git repository')
      }
      return { stdout: '', stderr: '' }
    })
    // The user deletes the leftover by hand and makes a folder of their own at the path.
    await rm(leftover, { recursive: true, force: true })
    await mkdir(leftover)
    await writeFile(join(leftover, 'notes.txt'), 'mine\n')
  })

  afterEach(async () => {
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  // What Orca keeps for every workspace it created, which alone once authorized deleting the path.
  function runtimeWithCreationMetadata() {
    const stale = createStaleRuntimeWorktreeStore(leftoverId, {
      orcaCreatedAt: Date.now(),
      orcaCreationSource: 'runtime'
    })
    return { runtime: createWorktreeRemovalRuntime(stale.runtimeStore), ...stale }
  }

  async function deleteById(runtime: ReturnType<typeof createWorktreeRemovalRuntime>) {
    await runtime
      .removeManagedWorktree(`id:${leftoverId}`, { force: true, waitForBackgroundRemoval: true })
      .catch(() => {})
    await _settlePendingWorktreeRemovalsForTests()
  }

  it('leaves the folder on Delete, and on every Delete after, ending the workspace', async () => {
    const { runtime, runtimeStore } = runtimeWithCreationMetadata()

    await deleteById(runtime)
    await deleteById(runtime)

    expect(existsSync(join(leftover, 'notes.txt'))).toBe(true)
    expect(runtimeStore.getWorktreeMeta(leftoverId)).toBeUndefined()
    await vi.waitFor(async () => expect(await readWorktreeRemovalRecords(directory)).toEqual([]))
  })

  it('leaves the folder on a Delete after another client’s listing ended the failed delete', async () => {
    const { runtime, runtimeStore } = runtimeWithCreationMetadata()

    const listed = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    expect(listed.worktrees.some((row) => row.id === leftoverId)).toBe(false)
    await deleteById(runtime)

    expect(existsSync(join(leftover, 'notes.txt'))).toBe(true)
    expect(runtimeStore.getWorktreeMeta(leftoverId)).toBeUndefined()
    await vi.waitFor(async () => expect(await readWorktreeRemovalRecords(directory)).toEqual([]))
  })

  it('leaves the folder on a Delete after a listing could not ask Git about the failed delete', async () => {
    vi.mocked(listWorktreesStrict).mockRejectedValueOnce(new Error('git worktree list timed out'))
    const { runtime, runtimeStore } = runtimeWithCreationMetadata()

    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    // Kept for the next listing to decide, rather than dropped with the workspace left behind.
    expect(await readWorktreeRemovalRecords(directory)).toHaveLength(1)
    await deleteById(runtime)

    expect(existsSync(join(leftover, 'notes.txt'))).toBe(true)
    expect(runtimeStore.getWorktreeMeta(leftoverId)).toBeUndefined()
  })

  it('leaves the folder on a Delete made while a listing asks Git about the failed delete', async () => {
    let answerGit!: () => void
    let askedGit!: () => void
    const listingAskedGit = new Promise<void>((resolve) => (askedGit = resolve))
    vi.mocked(listWorktreesStrict).mockImplementationOnce(() => {
      askedGit()
      return new Promise((resolve) => (answerGit = () => resolve([])))
    })
    const { runtime, runtimeStore } = runtimeWithCreationMetadata()

    const listing = runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    await listingAskedGit
    await deleteById(runtime)
    const notesAfterDelete = existsSync(join(leftover, 'notes.txt'))
    answerGit()
    await listing

    expect(notesAfterDelete).toBe(true)
    expect(runtimeStore.getWorktreeMeta(leftoverId)).toBeUndefined()
  })

  it('leaves the folder on a Delete after a restart’s refused delete could not ask Git what is left', async () => {
    // The delete was still running when Orca quit; the user replaced the folder before the restart.
    const [{ failure: _failure, ...interrupted }] = await readWorktreeRemovalRecords(directory)
    _resetPendingWorktreeRemovalsForTests()
    await writeWorktreeRemovalRecords(directory, () => [interrupted])
    await loadWorktreeRemovalRecords(directory)
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('git worktree list timed out'))
    const { runtime, runtimeStore } = runtimeWithCreationMetadata()

    runtime.finishInterruptedWorktreeRemovals()
    await _settlePendingWorktreeRemovalsForTests()
    expect(await readWorktreeRemovalRecords(directory)).toMatchObject([
      { worktreeId: leftoverId, failure: { message: expect.stringMatching(/is not the one Orca/) } }
    ])
    await deleteById(runtime)

    expect(existsSync(join(leftover, 'notes.txt'))).toBe(true)
    expect(runtimeStore.getWorktreeMeta(leftoverId)).toBeUndefined()
  })

  it('leaves a folder made at the path after a restart found the leftover gone', async () => {
    await rm(leftover, { recursive: true, force: true })
    _resetPendingWorktreeRemovalsForTests()
    await loadWorktreeRemovalRecords(directory)
    await mkdir(leftover)
    await writeFile(join(leftover, 'notes.txt'), 'mine\n')
    const { runtime, runtimeStore } = runtimeWithCreationMetadata()

    await deleteById(runtime)

    expect(existsSync(join(leftover, 'notes.txt'))).toBe(true)
    expect(runtimeStore.getWorktreeMeta(leftoverId)).toBeUndefined()
  })

  it('drops the failed delete from disk only once its workspace’s end is saved', async () => {
    const { runtimeStore } = runtimeWithCreationMetadata()
    let saved!: () => void
    const flushPendingOrThrowAsync = vi.fn(
      () => new Promise<void>((resolve) => (saved = () => resolve()))
    )
    const runtime = createWorktreeRemovalRuntime({ ...runtimeStore, flushPendingOrThrowAsync })

    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    expect(runtimeStore.getWorktreeMeta(leftoverId)).toBeUndefined()
    expect(flushPendingOrThrowAsync).toHaveBeenCalledOnce()
    // A crash now must still find the record, or the saved metadata would outlive it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await readWorktreeRemovalRecords(directory)).toHaveLength(1)

    saved()
    await vi.waitFor(async () => expect(await readWorktreeRemovalRecords(directory)).toEqual([]))
  })

  it('keeps the workspace when Git registers a checkout at the path again after the scan', async () => {
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      {
        path: leftover,
        head: 'def',
        branch: 'refs/heads/other',
        isBare: false,
        isMainWorktree: false
      }
    ])
    scanLocalRepoWorktreesForResolutionMock.mockResolvedValue({ ok: true, worktrees: [] })
    const { runtime, removeWorktreeMeta } = runtimeWithCreationMetadata()

    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    await vi.waitFor(async () => expect(await readWorktreeRemovalRecords(directory)).toEqual([]))
    expect(removeWorktreeMeta).not.toHaveBeenCalled()
  })
})
