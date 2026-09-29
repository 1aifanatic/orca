import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunnerModule from '../git/runner'
import type * as RefMaintenanceModule from '../git/local-repo-ref-maintenance'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof RunnerModule>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../git/local-repo-ref-maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof RefMaintenanceModule>()),
  armLocalRepoRefMaintenance: vi.fn(),
  setRepoRefMaintenanceBusyProbe: vi.fn()
}))

import { _resetCanonicalRepoKeyCacheForTests } from '../git/canonical-repo-key'
import { RuntimeRemoteFetchController } from './runtime-remote-fetch-controller'

const base = {
  remote: 'origin',
  branch: 'main',
  ref: 'refs/remotes/origin/main',
  base: 'origin/main'
}

type GitResult = { stdout: string; stderr: string }

function fetchCalls(): [string[], Record<string, unknown>][] {
  return gitExecFileAsyncMock.mock.calls.filter(([argv]: [string[]]) => argv.includes('fetch'))
}

let pendingFetches: ((result: GitResult) => void)[] = []

beforeEach(() => {
  _resetCanonicalRepoKeyCacheForTests()
  pendingFetches = []
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation((argv: string[]) => {
    if (argv[0] === 'rev-parse') {
      return Promise.resolve({ stdout: '/repo/.git\n', stderr: '' })
    }
    return new Promise<GitResult>((resolve) => {
      pendingFetches.push(resolve)
    })
  })
})

describe("a create's own base fetch", () => {
  it('starts at once instead of queueing behind the shared refresh chain', async () => {
    const controller = new RuntimeRemoteFetchController()
    const backgroundFetch = controller.getOrStartRemoteFetch('/repo', 'origin')
    await vi.waitFor(() => expect(fetchCalls()).toHaveLength(1))
    // A speculative refresh of the same base queues behind the full fetch.
    const queuedRefresh = controller.getOrStartRemoteTrackingBaseRefresh('/repo', base)

    const createFetch = controller.refreshRemoteTrackingBaseForCreate('/repo', base)
    await vi.waitFor(() => expect(fetchCalls()).toHaveLength(2))
    expect(fetchCalls()[1]?.[0]).toEqual(
      expect.arrayContaining([
        'fetch',
        '--no-tags',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main'
      ])
    )
    expect(fetchCalls()[1]?.[1]).toMatchObject({ cwd: '/repo', admissionTier: 'interactive' })

    pendingFetches[1]?.({ stdout: '', stderr: '' })
    await expect(createFetch).resolves.toEqual({ ok: true })

    pendingFetches[0]?.({ stdout: '', stderr: '' })
    await expect(Promise.all([backgroundFetch, queuedRefresh])).resolves.toEqual([
      { ok: true },
      { ok: true }
    ])
    // The create's completed fetch left the queued speculative refresh nothing to do.
    expect(fetchCalls()).toHaveLength(2)
  })

  it('reuses a base fetch that completed moments ago', async () => {
    const controller = new RuntimeRemoteFetchController()
    const refresh = controller.getOrStartRemoteTrackingBaseRefresh('/repo', base)
    await vi.waitFor(() => expect(fetchCalls()).toHaveLength(1))
    pendingFetches[0]?.({ stdout: '', stderr: '' })
    await refresh

    await expect(controller.refreshRemoteTrackingBaseForCreate('/repo', base)).resolves.toEqual({
      ok: true
    })
    expect(fetchCalls()).toHaveLength(1)
  })

  it('reports a failed fetch without throwing, so a create with a local base can go on', async () => {
    gitExecFileAsyncMock.mockImplementation((argv: string[]) =>
      argv[0] === 'rev-parse'
        ? Promise.resolve({ stdout: '/repo/.git\n', stderr: '' })
        : Promise.reject(new Error('network down'))
    )
    const controller = new RuntimeRemoteFetchController()
    await expect(controller.refreshRemoteTrackingBaseForCreate('/repo', base)).resolves.toEqual({
      ok: false,
      errorKind: 'git_error'
    })
  })
})
