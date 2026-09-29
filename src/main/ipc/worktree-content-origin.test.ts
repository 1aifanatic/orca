import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWorktreeContentOrigin } from './worktree-content-origin'
import type { GitRemoteExec } from './worktree-push-target-cleanup'

let repoPath: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' })
}

const realGit: GitRemoteExec = async (args, cwd) => ({
  stdout: execFileSync('git', args, { cwd, encoding: 'utf-8' })
})

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'orca-content-origin-'))
  git('init', '-q')
  git('remote', 'add', 'origin', 'https://example.com/me/repo.git')
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true })
})

async function originOf(baseBranch: string, execGit: GitRemoteExec = realGit) {
  return resolveWorktreeContentOrigin({ execGit, repoPath, baseBranch, pushTarget: undefined })
}

describe('resolveWorktreeContentOrigin', () => {
  it("reads a real repo's fork remotes: only the one Orca marked is third-party", async () => {
    git('remote', 'add', 'contributor-repo', 'https://example.com/contributor/repo.git')
    git('config', 'remote.contributor-repo.orca-created', 'true')
    git('remote', 'add', 'upstream', 'https://example.com/org/repo.git')
    git('config', 'branch.pr-fix.remote', 'contributor-repo')

    expect(await originOf('contributor-repo/fix')).toBe('cross-repo-review-head')
    expect(await originOf('pr-fix')).toBe('cross-repo-review-head')
    expect(await originOf('upstream/main')).toBe('repo-ref')
    expect(await originOf('origin/main')).toBe('repo-ref')
  })

  it('treats a repo with no fork remotes as its own content', async () => {
    expect(await originOf('origin/main')).toBe('repo-ref')
  })

  it('does not vouch for a named base when git cannot read the config', async () => {
    expect(
      await originOf('origin/main', async () => {
        throw new Error('relay disconnected')
      })
    ).toBe('unverified-commit')
  })
})
