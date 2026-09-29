// Real-binary coverage for finishing a removal a quit or crash interrupted: what is left has to
// come from Git and disk, whatever point the earlier run reached.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeRemovalOutcome } from '../../shared/worktree/removal-outcome'
import type { Store } from '../persistence'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  isWorktreeRemovalPending,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals
} from '../worktree-background-removal'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords,
  type WorktreeRemovalRecord
} from '../worktree-removal-records'
import { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))

const execFileAsync = promisify(execFile)

let scratchDir = ''
let recordsDir = ''
let repoPath = ''
let worktreePath = ''
let repo: Repo

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/....
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-interrupted-removal-')))
  recordsDir = join(scratchDir, 'profile')
  repoPath = join(scratchDir, 'repo')
  worktreePath = join(scratchDir, 'workspaces', 'feature')
  await mkdir(recordsDir, { recursive: true })
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'])
  await git(['config', 'user.email', 'removal@example.invalid'])
  await git(['config', 'user.name', 'Worktree Removal'])
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'seed'])
  await git(['worktree', 'add', '-q', worktreePath, '-b', 'feature'])
  repo = { id: 'repo-1', path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 0 }
})

afterEach(async () => {
  _resetPendingWorktreeRemovalsForTests()
  await rm(scratchDir, { recursive: true, force: true })
})

async function finishAfterRestart(options: { repoGone?: boolean; head?: string } = {}): Promise<{
  outcome: WorktreeRemovalOutcome | undefined
  purged: string[]
  remember: ReturnType<typeof vi.fn>
}> {
  const record: WorktreeRemovalRecord = {
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repoPath,
    worktreePath,
    branch: 'feature',
    head: options.head ?? (await git(['rev-parse', 'feature'])).trim(),
    deleteBranch: true,
    force: false,
    requestedAt: 1
  }
  await writeWorktreeRemovalRecords(recordsDir, () => [record])
  await loadWorktreeRemovalRecords(recordsDir)
  expect(isWorktreeRemovalPending(record.worktreeId)).toBe(true)

  const storeStub = {
    getRepo: (id: string) => (id === repo.id && !options.repoGone ? repo : undefined),
    getRepos: () => (options.repoGone ? [] : [repo]),
    getWorktreeMeta: () => undefined
  }
  const outcomes: WorktreeRemovalOutcome[] = []
  const purged: string[] = []
  const remember = vi.fn()
  resumeInterruptedWorktreeRemovals((interrupted) =>
    interruptedLocalWorktreeRemovalJob(interrupted, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the finish reads only repos and worktree metadata from the store here; git options and push-target cleanup are stubbed or short-circuit without a push target.
      store: storeStub as unknown as Store,
      acquireWatcherRemoval: async () => ({ finish: async () => {} }),
      closeWatchers: async () => {},
      preservedBranchCleanup: {
        preserveHead: (result) => result ?? {},
        remember
      },
      purge: ({ worktreeId }) => purged.push(worktreeId),
      onRemoved: () => {},
      publish: (_repoId, outcome) => {
        if (outcome) {
          outcomes.push(outcome)
        }
      }
    })
  )
  await _settlePendingWorktreeRemovalsForTests()
  expect(await readWorktreeRemovalRecords(recordsDir)).toEqual([])
  expect(isWorktreeRemovalPending(record.worktreeId)).toBe(false)
  return { outcome: outcomes.at(-1), purged, remember }
}

describe('finishing an interrupted worktree removal after a restart', () => {
  it('finishes a checkout Git was still deleting, branch and metadata included', async () => {
    // Git stopped partway: part of the checkout is gone, which reads as local changes.
    await unlink(join(worktreePath, 'seed.txt'))

    const { outcome, purged } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(outcome?.preservedBranch).toBeUndefined()
    expect(existsSync(worktreePath)).toBe(false)
    expect(await git(['worktree', 'list'])).not.toContain(worktreePath)
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('deletes the branch when Git finished the checkout but the quit came before the branch', async () => {
    await git(['worktree', 'remove', worktreePath])

    const { outcome, purged } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(await git(['branch', '--list', 'feature'])).toBe('')
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('keeps an unmerged branch, as a normal removal does', async () => {
    await writeFile(join(worktreePath, 'work.txt'), 'work\n')
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'work'], worktreePath)
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])

    const { outcome, remember } = await finishAfterRestart()

    expect(outcome).toMatchObject({
      status: 'removed',
      preservedBranch: { branchName: 'feature', head }
    })
    expect((await git(['rev-parse', 'feature'])).trim()).toBe(head)
    expect(remember).toHaveBeenCalledWith(
      `repo-1::${worktreePath}`,
      undefined,
      { preservedBranch: { branchName: 'feature', head } },
      head,
      undefined
    )
  })

  it('treats a removal that fully finished as done', async () => {
    const head = (await git(['rev-parse', 'feature'])).trim()
    await git(['worktree', 'remove', worktreePath])
    await git(['branch', '-d', 'feature'])

    const { outcome, purged } = await finishAfterRestart({ head })

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(outcome?.preservedBranch).toBeUndefined()
    expect(purged).toEqual([`repo-1::${worktreePath}`])
  })

  it('returns the row live when the finish fails, instead of retrying unseen', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Another Git client locked it while Orca was not running.
    await git(['worktree', 'lock', worktreePath])

    const { outcome, purged } = await finishAfterRestart()

    expect(outcome).toMatchObject({ status: 'failed' })
    expect(existsSync(worktreePath)).toBe(true)
    expect(await git(['worktree', 'list'])).toContain(worktreePath)
    expect(purged).toEqual([])
  })

  it('drops a record whose repo Orca no longer has', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { outcome, purged } = await finishAfterRestart({ repoGone: true })

    expect(outcome).toMatchObject({ status: 'removed' })
    expect(purged).toEqual([])
    expect(existsSync(worktreePath)).toBe(true)
  })
})
