import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, runtimeClientConstructorMock, serveOrcaAppMock, getDefaultUserDataPathMock } =
  vi.hoisted(() => ({
    callMock: vi.fn(),
    runtimeClientConstructorMock: vi.fn(),
    serveOrcaAppMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
  }))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

import { main } from './index'
import { RuntimeClientError } from './runtime/types'
import { WORKTREE_REMOVAL_WAIT_TIMEOUT_MS } from './handlers/worktree-removal-outcome'
import { okFixture, queueFixtures } from './test-fixtures'

describe('worktree rm reports the removal outcome, not its acceptance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let priorExitCode: typeof process.exitCode

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    priorExitCode = process.exitCode
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    process.exitCode = priorExitCode
  })

  const printed = (): string =>
    [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call.join(' ')).join('\n')

  function removeReplying(reply: Record<string, unknown>): void {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: { hostId: 'local' } }),
      okFixture('req', reply)
    )
  }

  it('asks the host to wait for the delete, with a wait long enough to cover it', async () => {
    removeReplying({ removed: true })

    await main(['worktree', 'rm', '--worktree', 'id:wt-1', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.rm',
      expect.objectContaining({ worktree: 'id:wt-1', waitForRemoval: true }),
      { timeoutMs: WORKTREE_REMOVAL_WAIT_TIMEOUT_MS }
    )
    expect(JSON.parse(printed()).result).toEqual({ removed: true })
  })

  it('never reports an older host acceptance as removed', async () => {
    removeReplying({ removed: true, removing: true })

    await main(['worktree', 'rm', '--worktree', 'id:wt-1', '--json'], '/tmp/repo')

    expect(JSON.parse(printed()).result).toEqual({ removed: false, removing: true })
    expect(process.exitCode).not.toBe(1)
  })

  it('says in plain output that an older host is still deleting the checkout', async () => {
    removeReplying({ removed: true, removing: true })

    await main(['worktree', 'rm', '--worktree', 'id:wt-1'], '/tmp/repo')

    expect(printed()).toBe(
      'removed: false\nOrca accepted the removal and is still deleting the checkout; this Orca version does not report when it finishes.'
    )
  })

  it('exits non-zero with the real error when the delete fails', async () => {
    queueFixtures(callMock, okFixture('req_show', { worktree: { hostId: 'local' } }))
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('runtime_error', 'Failed to delete worktree at /tmp/wt-1. EBUSY')
    )

    await main(['worktree', 'rm', '--worktree', 'id:wt-1', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(printed()).toContain('Failed to delete worktree at /tmp/wt-1. EBUSY')
  })

  it('says the removal may still be running when the wait runs out', async () => {
    queueFixtures(callMock, okFixture('req_show', { worktree: { hostId: 'local' } }))
    callMock.mockRejectedValueOnce(
      new RuntimeClientError(
        'runtime_timeout',
        'Timed out waiting for the Orca runtime to respond.'
      )
    )

    await main(['worktree', 'rm', '--worktree', 'id:wt-1', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(printed()).toContain('worktree_removal_still_running')
    expect(printed()).toContain('The removal may still be running')
  })
})
