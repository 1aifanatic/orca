import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWorktreePreparationLockReason,
  WORKTREE_CREATE_PREPARATION_DIRECTORY
} from '../../shared/worktree/create-preparation'
import { addWorktree } from './worktree-add'
import { runLocalWorktreeCreate } from './worktree-create-git-executor'
import {
  checkSparePostCheckoutHook,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'
import {
  _resetOwnedSpareIdsForTests,
  addOwnedSpareId,
  releaseOwnedSpareId
} from './worktree-create-spare-ids'
import { listWorktrees } from './worktree'
import { _resetLocalWorktreeCreateActivityForTests } from './local-worktree-create-activity'
import {
  _resetSparePoolForTests,
  findSpare,
  spareRepoKey,
  startSpare
} from '../worktree-create-preparation-pool'
import { sweepRetiredWorktreeCreatePreparations } from '../retired-worktree-create-preparation-sweep'

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

const gitMinor = Number(/git version 2\.(\d+)/.exec(git(tmpdir(), ['--version']))?.[1] ?? 0)

async function createRepo(): Promise<{ repoPath: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-spare-real-')))
  roots.push(root)
  const repoPath = join(root, 'repo')
  git(root, ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  git(repoPath, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(repoPath, ['add', 'version.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return { repoPath, root }
}

async function readySpare(repoPath: string, root: string): Promise<string> {
  const oid = git(repoPath, ['rev-parse', 'HEAD'])
  const { hookRun } = await checkSparePostCheckoutHook(repoPath, {})
  startSpare({ repoPath, workspaceRoot: root, oid, hookRun, options: {} })
  await vi.waitFor(() => expect(findSpare(spareRepoKey(repoPath))?.state).toBe('ready'), {
    timeout: 20_000
  })
  return oid
}

afterEach(async () => {
  _resetSparePoolForTests()
  _resetOwnedSpareIdsForTests()
  _resetLocalWorktreeCreateActivityForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('spare checkouts with real Git', () => {
  it.runIf(gitMinor >= 36)(
    'hands a spare over with a plain checkout’s hook arguments, status and reflog',
    async () => {
      const { repoPath, root } = await createRepo()
      const hookLog = join(root, 'hook.log')
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\necho "$1 $2 $3" >> "${hookLog}"\n`
      )
      await chmod(join(repoPath, '.git', 'hooks', 'post-checkout'), 0o755)
      git(repoPath, ['worktree', 'add', '--quiet', '-b', 'plain', join(root, 'plain'), 'main'])
      const oid = await readySpare(repoPath, root)
      const target = join(root, 'feature')

      const result = await runLocalWorktreeCreate(() =>
        addWorktree(repoPath, target, 'feature', 'main', false, false, {
          preparedCheckout: { workspaceRoot: root }
        })
      )

      expect(result.preparedCheckout).toEqual({ status: 'hit' })
      const [plainHook, spareHook] = (await readFile(hookLog, 'utf8')).trim().split('\n')
      expect(spareHook).toBe(plainHook)
      expect(spareHook).toBe(`${'0'.repeat(oid.length)} ${oid} 1`)
      expect(git(target, ['status', '--porcelain'])).toBe('')
      expect(git(target, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feature')
      expect(git(target, ['reflog', '-1', '--format=%gs', 'HEAD'])).toBe(
        `checkout: moving from ${oid} to feature`
      )
      expect(existsSync(join(repoPath, '.git', 'worktrees'))).toBe(true)
      const listed = await listWorktrees(repoPath)
      expect(listed.map((worktree) => worktree.branch)).toContain('refs/heads/feature')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'kills a spare mid-checkout at once, leaving it locked for the sweep',
    async () => {
      const { repoPath, root } = await createRepo()
      git(repoPath, ['config', 'filter.slow.smudge', 'sleep 20; cat'])
      git(repoPath, ['config', 'filter.slow.clean', 'cat'])
      await writeFile(join(repoPath, '.gitattributes'), '*.slow filter=slow\n')
      await writeFile(join(repoPath, 'payload.slow'), 'payload\n')
      git(repoPath, ['add', '.'])
      git(repoPath, ['commit', '--quiet', '-m', 'slow checkout'])
      const oid = git(repoPath, ['rev-parse', 'HEAD'])
      // As a crash would leave it: the build is stopped and nothing in this process discards it.
      const id = `${process.pid}-22222222-2222-4222-8222-222222222222`
      const preparedPath = join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY, id)
      await mkdir(join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY))
      const lockFile = join(repoPath, '.git', 'worktrees', id, 'locked')
      const controller = new AbortController()
      const build = prepareWorktreeCreateCheckout(
        repoPath,
        preparedPath,
        oid,
        createWorktreePreparationLockReason(id),
        { signal: controller.signal }
      )
      await vi.waitFor(() => expect(existsSync(lockFile)).toBe(true), { timeout: 10_000 })

      const abortedAt = Date.now()
      controller.abort()
      await expect(build).rejects.toThrow()

      expect(Date.now() - abortedAt).toBeLessThan(10_000)
      expect((await readFile(lockFile, 'utf8')).trim()).toBe(
        createWorktreePreparationLockReason(id)
      )
      const swept = await sweepRetiredWorktreeCreatePreparations({
        workspaceRoots: [root],
        repos: [{ path: repoPath }]
      })
      expect(swept.reclaimed).toBe(1)
      expect(existsSync(preparedPath)).toBe(false)
    },
    30_000
  )

  it('hides an owned spare from listings before Git records its lock', async () => {
    const { repoPath, root } = await createRepo()
    const id = `${process.pid}-11111111-1111-4111-8111-111111111111`
    const sparePath = join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY, id)
    await mkdir(join(root, WORKTREE_CREATE_PREPARATION_DIRECTORY))
    addOwnedSpareId(id)
    git(repoPath, ['worktree', 'add', '--detach', '--quiet', sparePath, 'main'])

    expect((await listWorktrees(repoPath)).map((worktree) => worktree.path)).not.toContain(
      sparePath
    )
    releaseOwnedSpareId(id)
    expect((await listWorktrees(repoPath)).map((worktree) => worktree.path)).toContain(sparePath)
  })
})
