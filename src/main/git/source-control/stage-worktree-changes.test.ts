import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_GIT_STATUS_LIMIT } from '../../../shared/git-status-limit'
import { getStatus } from '../status'
import { bulkStageFiles, stageWorktreeChanges } from './staging'

const tempRoots: string[] = []
const OVER_CAP = DEFAULT_GIT_STATUS_LIMIT + 50

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

function names(repo: string, args: string[]): string[] {
  return git(repo, args).split('\n').filter(Boolean)
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-stage-worktree-'))
  tempRoots.push(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  return repo
}

async function createOverCapRepo(): Promise<string> {
  const repo = await createRepo()
  await mkdir(path.join(repo, 'big'))
  for (let i = 0; i < OVER_CAP; i++) {
    await writeFile(path.join(repo, 'big', `f${String(i).padStart(5, '0')}.txt`), 'a\n')
  }
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'initial'])
  for (let i = 0; i < OVER_CAP; i++) {
    await writeFile(path.join(repo, 'big', `f${String(i).padStart(5, '0')}.txt`), 'b\n')
  }
  await writeFile(path.join(repo, 'zz-new.txt'), 'new\n')
  return repo
}

async function createConflictRepo(): Promise<string> {
  const repo = await createRepo()
  await writeFile(path.join(repo, 'conflict.txt'), 'base\n')
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'base'])
  git(repo, ['checkout', '-q', '-b', 'side'])
  await writeFile(path.join(repo, 'conflict.txt'), 'side\n')
  git(repo, ['commit', '-q', '-am', 'side'])
  git(repo, ['checkout', '-q', 'main'])
  await writeFile(path.join(repo, 'conflict.txt'), 'main\n')
  git(repo, ['commit', '-q', '-am', 'main'])
  try {
    git(repo, ['merge', '-q', 'side'])
  } catch {
    // Expected: the merge stops on conflict.txt.
  }
  await writeFile(path.join(repo, 'tracked.txt'), 'changed\n')
  await writeFile(path.join(repo, 'untracked.txt'), 'new\n')
  return repo
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('stageWorktreeChanges', () => {
  it('stages every change when the status listing hit its cap', async () => {
    const repo = await createOverCapRepo()
    const status = await getStatus(repo)
    expect(status.didHitLimit).toBe(true)
    const listed = status.entries.map((entry) => entry.path)

    // The old Stage All: only the capped listing reaches git.
    await bulkStageFiles(repo, listed)
    expect(names(repo, ['diff', '--name-only']).length).toBeGreaterThan(0)

    git(repo, ['reset', '-q'])
    await stageWorktreeChanges(repo, 'all')
    expect(names(repo, ['diff', '--name-only'])).toEqual([])
    expect(names(repo, ['ls-files', '--others', '--exclude-standard'])).toEqual([])
    expect(names(repo, ['diff', '--cached', '--name-only'])).toHaveLength(OVER_CAP + 1)
  })

  it('stages only tracked changes for the tracked scope', async () => {
    const repo = await createOverCapRepo()

    await stageWorktreeChanges(repo, 'tracked')

    expect(names(repo, ['diff', '--name-only'])).toEqual([])
    expect(names(repo, ['ls-files', '--others', '--exclude-standard'])).toEqual(['zz-new.txt'])
  })

  it('leaves unresolved conflicts unstaged', async () => {
    const repo = await createConflictRepo()

    await stageWorktreeChanges(repo, 'all')

    expect(names(repo, ['diff', '--name-only', '--diff-filter=U'])).toEqual(['conflict.txt'])
    expect(names(repo, ['diff', '--cached', '--name-only', '--diff-filter=M'])).toEqual([
      'tracked.txt'
    ])
    expect(names(repo, ['diff', '--cached', '--name-only', '--diff-filter=A'])).toEqual([
      'untracked.txt'
    ])
  })
  it('stays inside a folder workspace nested in a larger repo', async () => {
    const repo = await createRepo()
    await mkdir(path.join(repo, 'folder'))
    await writeFile(path.join(repo, 'folder', 'inside.txt'), 'a\n')
    await writeFile(path.join(repo, 'outside.txt'), 'a\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    await writeFile(path.join(repo, 'folder', 'inside.txt'), 'b\n')
    await writeFile(path.join(repo, 'outside.txt'), 'b\n')
    await writeFile(path.join(repo, 'folder', 'new.txt'), 'new\n')

    await stageWorktreeChanges(path.join(repo, 'folder'), 'all')

    expect(names(repo, ['diff', '--cached', '--name-only'])).toEqual([
      'folder/inside.txt',
      'folder/new.txt'
    ])
    expect(names(repo, ['diff', '--name-only'])).toEqual(['outside.txt'])
  })

  it('leaves unresolved conflicts unstaged in a nested folder too', async () => {
    const repo = await createConflictRepo()
    await mkdir(path.join(repo, 'sub'))
    await writeFile(path.join(repo, 'sub', 'new.txt'), 'new\n')

    await stageWorktreeChanges(path.join(repo, 'sub'), 'all')

    expect(names(repo, ['diff', '--name-only', '--diff-filter=U'])).toEqual(['conflict.txt'])
    expect(names(repo, ['diff', '--cached', '--name-only', '--diff-filter=A'])).toEqual([
      'sub/new.txt'
    ])
  })
})
