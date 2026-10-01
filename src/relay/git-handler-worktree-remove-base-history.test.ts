// Real-binary coverage: SSH workspaces are cut with `--no-track` too, so `-d` compares against the
// main checkout's HEAD and refuses branches whose base already holds their head.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { GitHandler } from './git-handler'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

describe('relay removal of a branch whose base already holds its head', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let scratchDir: string
  let repoPath: string

  function addWorkspace(name: string, base: string): string {
    const worktreePath = path.join(scratchDir, name)
    git(['worktree', 'add', '-q', '--no-track', '-b', name, worktreePath, base], repoPath)
    git(['config', `branch.${name}.base`, base], repoPath)
    return worktreePath
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    scratchDir = realpathSync(createGitTempDir())
    repoPath = path.join(scratchDir, 'repo')
    mkdirSync(repoPath)
    gitInit(repoPath)
    writeFileSync(path.join(repoPath, 'seed.txt'), 'seed\n')
    gitCommit(repoPath, 'seed')
    git(['branch', '-M', 'main'], repoPath)
    const originPath = path.join(scratchDir, 'origin.git')
    git(['init', '-q', '--bare', originPath], scratchDir)
    git(['remote', 'add', 'origin', originPath], repoPath)
    // Someone's open review branch, fetched but never checked out here.
    git(['checkout', '-q', '-b', 'author-work'], repoPath)
    writeFileSync(path.join(repoPath, 'feature.txt'), 'feature\n')
    gitCommit(repoPath, 'feature')
    git(['push', '-q', 'origin', 'author-work:feature-x', 'main:main'], repoPath)
    git(['checkout', '-q', 'main'], repoPath)
    git(['branch', '-D', 'author-work'], repoPath)
    git(['fetch', '-q', 'origin'], repoPath)
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    handler.dispose()
    vi.restoreAllMocks()
    await removeGitTempDir(scratchDir)
  })

  it("deletes a workspace opened on someone's review branch with no commits", async () => {
    const worktreePath = addWorkspace('feature-x', 'refs/remotes/origin/feature-x')

    await expect(dispatcher.callRequest('git.removeWorktree', { worktreePath })).resolves.toEqual(
      {}
    )
    expect(git(['branch', '--list', 'feature-x'], repoPath)).toBe('')
  })

  it('keeps a workspace with a commit its base does not hold', async () => {
    const worktreePath = addWorkspace('unpushed', 'refs/remotes/origin/feature-x')
    writeFileSync(path.join(worktreePath, 'unpushed.txt'), 'unpushed\n')
    gitCommit(worktreePath, 'unpushed')
    const head = git(['rev-parse', 'HEAD'], worktreePath)

    await expect(dispatcher.callRequest('git.removeWorktree', { worktreePath })).resolves.toEqual({
      preservedBranch: { branchName: 'unpushed', head }
    })
    expect(git(['rev-parse', 'refs/heads/unpushed'], repoPath)).toBe(head)
  })
})
