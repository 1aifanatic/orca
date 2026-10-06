import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), acquire: vi.fn(), release: vi.fn() }))
vi.mock('./gh-utils', () => ({
  acquire: mocks.acquire,
  release: mocks.release,
  githubRepoContext: (repoPath: string, connectionId: string | null, options: object) => ({
    repoPath,
    connectionId,
    ...options
  }),
  ghRepoExecOptions: (context: object) => context
}))
vi.mock('./client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProviderGeneration: () => 1 }))
import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'

const outcome: PRRefreshOutcome = { kind: 'no-pr', fetchedAt: 1 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.acquire.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PR lookup coalescing', () => {
  it('shares pending reads across callers and releases them after settlement', async () => {
    let finish: ((value: PRRefreshOutcome) => void) | undefined
    mocks.resolve.mockImplementation(
      () =>
        new Promise<PRRefreshOutcome>((resolve) => {
          finish = resolve
        })
    )
    const first = getPRForBranchOutcome('/repo', 'refs/heads/topic')
    const second = getPRForBranchOutcome('/repo', 'topic')
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
    finish?.(outcome)
    expect(await Promise.all([first, second])).toEqual([outcome, outcome])
    mocks.resolve.mockResolvedValue(outcome)
    await getPRForBranchOutcome('/repo', 'topic')
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('shares a background read with a foreground caller of the same lookup', async () => {
    mocks.resolve.mockResolvedValue(outcome)
    await Promise.all([
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { admissionTier: 'background' }
      }),
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { admissionTier: 'interactive' }
      })
    ])
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
  })

  it('isolates heads, fallback hints, accounts, execution hosts, and credentials', async () => {
    mocks.resolve.mockResolvedValue(outcome)
    const requests = [
      getPRForBranchOutcome('/repo', 'topic'),
      getPRForBranchOutcome('/repo', 'topic', 12),
      getPRForBranchOutcome('/repo', 'topic', null, 'ssh-1'),
      getPRForBranchOutcome('/repo', 'topic', null, null, 12),
      getPRForBranchOutcome('/repo', 'topic', null, null, null, { currentHeadOid: 'other-head' }),
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      }),
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { ghAccount: { host: 'github.com', user: 'other' } }
      })
    ]
    vi.stubEnv('GH_TOKEN', 'test-only-other-token')
    requests.push(getPRForBranchOutcome('/repo', 'topic'))
    await Promise.all(requests)
    expect(mocks.resolve).toHaveBeenCalledTimes(8)
  })

  it('cleans up errors so later reads can recover', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(outcome)
    const results = await Promise.all([
      getPRForBranchOutcome('/repo', 'topic'),
      getPRForBranchOutcome('/repo', 'topic')
    ])
    expect(results.every((result) => result.kind === 'upstream-error')).toBe(true)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    await expect(getPRForBranchOutcome('/repo', 'topic')).resolves.toEqual(outcome)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })
})
