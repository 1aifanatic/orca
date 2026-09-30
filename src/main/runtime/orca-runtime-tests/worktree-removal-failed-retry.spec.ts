// A runtime Delete (paired desktop, web, mobile, CLI) on the leftover of a delete that failed after
// Git dropped the registration: the leftover is listed with its error and Delete runs the recorded
// removal again, instead of the leftover vanishing from every listing.
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  join,
  listWorktreesStrict,
  mkdir,
  mkdtemp,
  removeWorktree,
  rm,
  tmpdir
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_REPO_PATH } from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords
} from '../../worktree-background-removal'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords
} from '../../worktree-removal-records'

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
        failure: { message: FAILURE, failedAt: 2 }
      }
    ])
    await loadWorktreeRemovalRecords(directory)
  })

  afterEach(async () => {
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

  it('replies to a waiting client once the retry finishes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = createWorktreeRemovalRuntime()

    await expect(
      runtime.removeManagedWorktree(`id:${leftoverId}`, { waitForBackgroundRemoval: true })
    ).resolves.toEqual({})
    expect(existsSync(leftover)).toBe(false)
  })
})
