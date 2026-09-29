import { describe, expect, it } from 'vitest'
import { classifyWorktreeContentOrigin, isFirstPartyWorktreeContentOrigin } from './content-origin'

const SHA = 'a'.repeat(40)

describe('classifyWorktreeContentOrigin', () => {
  it('treats a branch or default base as the repository own content', () => {
    expect(classifyWorktreeContentOrigin({ baseBranch: undefined, pushTarget: undefined })).toBe(
      'repo-ref'
    )
    expect(
      classifyWorktreeContentOrigin({ baseBranch: 'origin/main', pushTarget: undefined })
    ).toBe('repo-ref')
  })

  it('recognises a same-repository PR head by its push target on an existing remote', () => {
    expect(
      classifyWorktreeContentOrigin({
        baseBranch: SHA,
        pushTarget: { remoteName: 'origin', branchName: 'feature' }
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
        }
      })
    ).toBe('cross-repo-review-head')
  })

  it('cannot vouch for a bare commit with no push target', () => {
    expect(classifyWorktreeContentOrigin({ baseBranch: SHA, pushTarget: undefined })).toBe(
      'unverified-commit'
    )
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
