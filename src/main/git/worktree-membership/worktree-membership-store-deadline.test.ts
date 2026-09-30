// A hung mount (stalled NFS/SMB/WSL 9p) never settles an fs read. The model must fail the read by
// the caller's deadline, as Git's own timeout does, and must not queue more fs work behind it.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hang = vi.hoisted(() => ({ prefix: '', started: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const hangUnderPrefix =
    <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (hang.prefix && String(args[0]).startsWith(hang.prefix)) {
        hang.started += 1
        return new Promise<R>(() => {})
      }
      return read(...args)
    }
  return {
    ...actual,
    stat: hangUnderPrefix(actual.stat),
    lstat: hangUnderPrefix(actual.lstat),
    readdir: hangUnderPrefix(actual.readdir),
    readFile: hangUnderPrefix(actual.readFile),
    realpath: hangUnderPrefix(actual.realpath)
  }
})

import {
  _resetWorktreeMembershipModelsForTests,
  markWorktreeMembershipDirty,
  readWorktreeMembership,
  WorktreeMembershipTimeoutError
} from './worktree-membership-store'
import { MEMBERSHIP_READ_MEMO_MS } from './worktree-membership-model'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''

async function git(args: string[], cwd = repoPath): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-membership-deadline-')))
  repoPath = join(scratchDir, 'repo')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q', '-b', 'main'])
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['-c', 'user.email=d@example.invalid', '-c', 'user.name=D', 'commit', '-qm', 'seed'])
  await git(['worktree', 'add', '-q', join(scratchDir, 'linked'), '-b', 'linked'])
  _resetWorktreeMembershipModelsForTests()
  hang.prefix = ''
  hang.started = 0
})

afterEach(async () => {
  hang.prefix = ''
  vi.restoreAllMocks()
  _resetWorktreeMembershipModelsForTests()
  await rm(scratchDir, { recursive: true, force: true })
})

describe('worktree membership model on a hung mount', () => {
  it('fails a warm read by its deadline and starts no fs work behind the stalled one', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    hang.prefix = join(repoPath, '.git')
    now += MEMBERSHIP_READ_MEMO_MS

    await expect(readWorktreeMembership(repoPath, { timeout: 50 })).rejects.toBeInstanceOf(
      WorktreeMembershipTimeoutError
    )
    const stalledReads = hang.started
    for (let round = 0; round < 3; round++) {
      markWorktreeMembershipDirty(repoPath)
      await expect(readWorktreeMembership(repoPath, { timeout: 50 })).rejects.toBeInstanceOf(
        WorktreeMembershipTimeoutError
      )
    }
    expect(hang.started).toBe(stalledReads)
  })

  it('fails a cold build by its deadline and joins it instead of building again', async () => {
    hang.prefix = join(repoPath, '.git')
    await expect(readWorktreeMembership(repoPath, { timeout: 50 })).rejects.toBeInstanceOf(
      WorktreeMembershipTimeoutError
    )
    const stalledReads = hang.started
    await expect(readWorktreeMembership(repoPath, { timeout: 50 })).rejects.toBeInstanceOf(
      WorktreeMembershipTimeoutError
    )
    expect(hang.started).toBe(stalledReads)
  })

  it('answers a read inside the memo without touching the disk', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    const { rows } = await readWorktreeMembership(repoPath)
    hang.prefix = scratchDir
    await expect(readWorktreeMembership(repoPath, { timeout: 50 })).resolves.toEqual({
      rows,
      fromModel: true
    })
    expect(hang.started).toBe(0)
  })
})
