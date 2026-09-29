import { describe, expect, it } from 'vitest'
import {
  classifyWorktreeContentOrigin,
  isBaseOnOrcaForkRemote,
  isFirstPartyWorktreeContentOrigin
} from './content-origin'

const SHA = 'a'.repeat(40)
const NO_FORKS = 'core.repositoryformatversion 0\n'
const FORK_CONFIG = [
  'core.repositoryformatversion 0',
  'remote.contributor-repo.orca-created true',
  'remote.upstream.orca-created false',
  'branch.main.remote origin',
  'branch.pr/fix.remote contributor-repo'
].join('\n')

describe('classifyWorktreeContentOrigin', () => {
  it('treats a branch or default base as the repository own content', () => {
    expect(
      classifyWorktreeContentOrigin({
        baseBranch: undefined,
        pushTarget: undefined,
        forkRemoteConfig: null
      })
    ).toBe('repo-ref')
    expect(
      classifyWorktreeContentOrigin({
        baseBranch: 'origin/main',
        pushTarget: undefined,
        forkRemoteConfig: NO_FORKS
      })
    ).toBe('repo-ref')
  })

  it('marks a named base on a fork remote Orca added as third-party', () => {
    expect(
      classifyWorktreeContentOrigin({
        baseBranch: 'contributor-repo/fix',
        pushTarget: undefined,
        forkRemoteConfig: FORK_CONFIG
      })
    ).toBe('cross-repo-review-head')
  })

  it('does not vouch for a named base when the fork remotes could not be read', () => {
    expect(
      classifyWorktreeContentOrigin({
        baseBranch: 'origin/main',
        pushTarget: undefined,
        forkRemoteConfig: null
      })
    ).toBe('unverified-commit')
  })

  it('recognises a same-repository PR head by its push target on an existing remote', () => {
    expect(
      classifyWorktreeContentOrigin({
        baseBranch: SHA,
        pushTarget: { remoteName: 'origin', branchName: 'feature' },
        forkRemoteConfig: null
      })
    ).toBe('same-repo-review-head')
  })

  it('marks a fork PR head, whose push target names the fork URL, as third-party', () => {
    expect(
      classifyWorktreeContentOrigin({
        baseBranch: SHA,
        pushTarget: {
          remoteName: 'contributor-repo',
          branchName: 'fix',
          remoteUrl: 'https://github.com/contributor/repo.git'
        },
        forkRemoteConfig: null
      })
    ).toBe('cross-repo-review-head')
  })

  it('cannot vouch for a bare commit with no push target', () => {
    expect(
      classifyWorktreeContentOrigin({
        baseBranch: SHA,
        pushTarget: undefined,
        forkRemoteConfig: ''
      })
    ).toBe('unverified-commit')
  })
})

describe('isBaseOnOrcaForkRemote', () => {
  it('matches every spelling of a fork remote ref, and a local branch tracking one', () => {
    for (const base of [
      'contributor-repo/fix',
      'remotes/contributor-repo/fix',
      'refs/remotes/contributor-repo/fix',
      'pr/fix',
      'refs/heads/pr/fix'
    ]) {
      expect(isBaseOnOrcaForkRemote(base, FORK_CONFIG)).toBe(true)
    }
  })

  it("leaves the user's own remotes and branches alone", () => {
    for (const base of [
      'origin/main',
      'upstream/main',
      'main',
      'contributor-repo',
      'contributor-repo-2/fix'
    ]) {
      expect(isBaseOnOrcaForkRemote(base, FORK_CONFIG)).toBe(false)
    }
  })
})

describe('isFirstPartyWorktreeContentOrigin', () => {
  it('excludes forks, bare commits and worktrees created before the field existed', () => {
    expect(isFirstPartyWorktreeContentOrigin('repo-ref')).toBe(true)
    expect(isFirstPartyWorktreeContentOrigin('same-repo-review-head')).toBe(true)
    expect(isFirstPartyWorktreeContentOrigin('cross-repo-review-head')).toBe(false)
    expect(isFirstPartyWorktreeContentOrigin('unverified-commit')).toBe(false)
    expect(isFirstPartyWorktreeContentOrigin(undefined)).toBe(false)
  })
})
