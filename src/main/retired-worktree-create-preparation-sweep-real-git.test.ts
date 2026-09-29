import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { listWorktreeGraph } from './git/worktree-listing'
import { _resetWorktreeScanCacheForTests } from './git/worktree-scan-cache'
import { sweepRetiredWorktreeCreatePreparations } from './retired-worktree-create-preparation-sweep'
import type { Repo } from '../shared/repo-types'

const DEAD_PID = 999_991
const LIVE_PID = 999_992
const roots: string[] = []

afterEach(async () => {
  _resetWorktreeScanCacheForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function spareName(pid: number, suffix: string): string {
  return `${pid}-${suffix}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
}

async function addLockedSpare(repo: string, path: string, pid: number): Promise<void> {
  await gitExecFileAsync(['worktree', 'add', '--detach', path, 'main'], { cwd: repo })
  await gitExecFileAsync(
    ['worktree', 'lock', '--reason', `orca-create-preparation:v1:${pid}:session`, path],
    { cwd: repo }
  )
}

it('reclaims spares left by dead Orca processes and leaves everything else alone', async () => {
  // Git reports resolved paths, and macOS temp dirs sit behind a symlink.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-retired-spares-')))
  roots.push(root)
  const repo = join(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  await gitExecFileAsync(['init', '--quiet', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await writeFile(join(repo, 'file.txt'), 'content\n')
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo }
  )

  const deadSpare = join(spares, spareName(DEAD_PID, '11111111'))
  const liveSpare = join(spares, spareName(LIVE_PID, '22222222'))
  const orphanDirectory = join(spares, spareName(DEAD_PID, '33333333'))
  const userWorktree = join(workspaceRoot, 'feature')
  await addLockedSpare(repo, deadSpare, DEAD_PID)
  await addLockedSpare(repo, liveSpare, LIVE_PID)
  await mkdir(orphanDirectory, { recursive: true })
  await writeFile(join(orphanDirectory, 'file.txt'), 'leftover\n')
  await gitExecFileAsync(['worktree', 'add', '-b', 'feature', userWorktree, 'main'], { cwd: repo })

  const repoRecord: Repo = {
    id: 'repo-1',
    path: repo,
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0
  }
  const result = await sweepRetiredWorktreeCreatePreparations(
    [{ repo: repoRecord, workspaceRoot, gitOptions: {} }],
    { isProcessAlive: (pid) => pid === LIVE_PID }
  )

  expect(result).toEqual({ reclaimed: 1, removedDirectories: 1 })
  expect(existsSync(deadSpare)).toBe(false)
  expect(existsSync(orphanDirectory)).toBe(false)
  // A running older Orca still owns its spare, so the shared folder stays too.
  expect(existsSync(liveSpare)).toBe(true)
  expect(existsSync(userWorktree)).toBe(true)
  const paths = (await listWorktreeGraph(repo, { includeCreatePreparations: true })).map(
    (worktree) => worktree.path
  )
  expect(paths).toContain(liveSpare)
  expect(paths).toContain(userWorktree)
  expect(paths).not.toContain(deadSpare)
})

it('skips SSH and folder repos without touching Git', async () => {
  const result = await sweepRetiredWorktreeCreatePreparations([
    {
      repo: {
        id: 'ssh',
        path: '/remote/repo',
        displayName: 'Remote',
        badgeColor: '#000000',
        addedAt: 0,
        connectionId: 'conn-1'
      },
      workspaceRoot: join(tmpdir(), 'orca-no-such-root'),
      gitOptions: {}
    }
  ])
  expect(result).toEqual({ reclaimed: 0, removedDirectories: 0 })
})
