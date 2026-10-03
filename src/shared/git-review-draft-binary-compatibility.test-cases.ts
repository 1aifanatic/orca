import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createGitHandlerRelay } from '../relay/git-handler-test-harness'

export function registerGitReviewDraftBinaryCompatibilityCase(
  runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  paths: () => { fixturePath: string; fixtureCwd: string }
): void {
  it('reads complete review drafts through the relay fixed diff formats', async () => {
    const { fixturePath, fixtureCwd } = paths()
    await mkdir(fixturePath)
    const git = (args: string[]) => runGit(['-C', fixtureCwd, ...args])
    await git(['init', '-q'])
    await git(['config', 'user.name', 'Review Compatibility'])
    await git(['config', 'user.email', 'review@example.invalid'])
    await writeFile(join(fixturePath, 'evidence.txt'), 'before\n')
    await git(['add', 'evidence.txt'])
    await git(['commit', '-qm', 'initial'])
    const mergeBase = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(join(fixturePath, 'evidence.txt'), 'after\n')
    await git(['commit', '-qam', 'review evidence'])
    const before = (await git(['status', '--porcelain'])).stdout
    const { dispatcher, handler } = createGitHandlerRelay()
    Object.assign(handler, { git })
    try {
      await expect(
        dispatcher.callRequest('git.reviewDiff', {
          worktreePath: fixtureCwd,
          mergeBase,
          format: 'name-status'
        })
      ).resolves.toEqual({ stdout: 'M\tevidence.txt\n', stderr: '' })
      const patch = await dispatcher.callRequest('git.reviewDiff', {
        worktreePath: fixtureCwd,
        mergeBase,
        format: 'patch'
      })
      expect(patch).toMatchObject({ stdout: expect.stringContaining('-before\n+after\n') })
      expect((await git(['status', '--porcelain'])).stdout).toBe(before)
    } finally {
      handler.dispose()
    }
  })
}
