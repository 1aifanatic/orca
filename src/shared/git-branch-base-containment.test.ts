import { describe, expect, it } from 'vitest'
import {
  isBranchHeadInBaseHistory,
  readBranchBaseRefs,
  type GitBranchBaseRunner
} from './git-branch-base-containment'

const HEAD = 'a'.repeat(40)

function runner(outputs: Record<string, string>, calls: string[][] = []): GitBranchBaseRunner {
  return async (argv) => {
    calls.push(argv)
    const output = outputs[argv.join(' ')]
    if (output === undefined) {
      throw new Error(`git ${argv.join(' ')} failed`)
    }
    return { stdout: output }
  }
}

describe('readBranchBaseRefs', () => {
  it('reads the saved base, the remote default and HEAD, without repeats', async () => {
    const runGit = runner({
      'config --get branch.feature.base': 'refs/remotes/origin/main\n',
      'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/main\n'
    })

    await expect(readBranchBaseRefs(runGit, 'feature')).resolves.toEqual([
      'refs/remotes/origin/main',
      'HEAD'
    ])
  })

  it('qualifies a short saved base and drops a bare commit id', async () => {
    const short = runner({
      'config --get branch.feature.base': 'origin/main\n',
      'rev-parse --symbolic-full-name origin/main': 'refs/remotes/origin/main\n'
    })
    await expect(readBranchBaseRefs(short, 'feature')).resolves.toEqual([
      'refs/remotes/origin/main',
      'HEAD'
    ])

    const commit = runner({
      'config --get branch.feature.base': `${HEAD}\n`,
      [`rev-parse --symbolic-full-name ${HEAD}`]: '\n'
    })
    await expect(readBranchBaseRefs(commit, 'feature')).resolves.toEqual(['HEAD'])
  })

  it('never compares a branch against itself', async () => {
    const runGit = runner({ 'config --get branch.feature.base': 'refs/heads/feature\n' })

    await expect(readBranchBaseRefs(runGit, 'feature')).resolves.toEqual(['HEAD'])
  })
})

describe('isBranchHeadInBaseHistory', () => {
  it('stops at the first base whose history holds the head', async () => {
    const calls: string[][] = []
    const runGit = runner(
      {
        'config --get branch.feature.base': 'refs/remotes/origin/feature\n',
        [`merge-base --is-ancestor ${HEAD} refs/remotes/origin/feature`]: ''
      },
      calls
    )

    await expect(isBranchHeadInBaseHistory(runGit, 'feature', HEAD)).resolves.toBe(true)
    expect(calls.at(-1)).toEqual([
      'merge-base',
      '--is-ancestor',
      HEAD,
      'refs/remotes/origin/feature'
    ])
  })

  it('is false when no base holds the head, and never runs Git for a malformed head', async () => {
    await expect(isBranchHeadInBaseHistory(runner({}), 'feature', HEAD)).resolves.toBe(false)

    const calls: string[][] = []
    await expect(isBranchHeadInBaseHistory(runner({}, calls), 'feature', '--all')).resolves.toBe(
      false
    )
    expect(calls).toEqual([])
  })
})
