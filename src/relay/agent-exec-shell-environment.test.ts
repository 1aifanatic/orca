import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { resolveLoginShellEnvironment } from '../main/startup/login-shell-environment'
import { createFakeChild, createHandlers, requestContext } from './agent-exec-handler-test-harness'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn()
}))
vi.mock('../main/startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: vi.fn()
}))

describe('relay headless generation shell environment', () => {
  it('uses the execution host profile PATH and retains explicit command overrides', async () => {
    vi.mocked(resolveLoginShellEnvironment).mockResolvedValue({
      PATH: '/profile/bin:/usr/bin',
      MODEL: 'profile'
    })
    const child = createFakeChild()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fake provides the streams and lifecycle used by the relay.
    vi.mocked(spawn).mockReturnValue(child as never)
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', shell: true, env: { MODEL: 'override' } },
      requestContext()
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    child.emit('close', 0)
    await expect(pending).resolves.toMatchObject({ exitCode: 0 })
    expect(spawn).toHaveBeenLastCalledWith(
      'opencode',
      ['run'],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: '/profile/bin:/usr/bin', MODEL: 'override' })
      })
    )
  })

  it('does not start generation after cancellation during profile resolution', async () => {
    vi.mocked(spawn).mockClear()
    let resolveProfile: (env: NodeJS.ProcessEnv) => void = () => {}
    vi.mocked(resolveLoginShellEnvironment).mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve
      })
    )
    const handlers = createHandlers()
    const pending = handlers.get('agent.execNonInteractive')?.(
      { binary: 'opencode', args: ['run'], cwd: '/repo', operation: 'commit-message', shell: true },
      requestContext()
    )
    await expect(
      handlers.get('agent.cancelExec')?.(
        { cwd: '/repo', operation: 'commit-message' },
        requestContext()
      )
    ).resolves.toEqual({ canceled: true })
    resolveProfile({ PATH: '/profile/bin' })
    await expect(pending).resolves.toMatchObject({ canceled: true })
    expect(spawn).not.toHaveBeenCalled()
  })
})
