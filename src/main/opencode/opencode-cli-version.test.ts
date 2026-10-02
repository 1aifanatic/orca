import { beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { probeOpenCodeCliVersion } from './opencode-cli-version'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
beforeEach(() => vi.mocked(runProcess).mockReset())

it('shares concurrent probes and isolates executable, host and environment identities', async () => {
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '1.1.23',
    stderr: '',
    timedOut: false
  })
  const options = {
    executablePath: '/test/opencode',
    env: { PATH: '/runtime', XDG_CONFIG_HOME: '/one' },
    hostIdentity: 'native'
  }
  const results = await Promise.all([
    probeOpenCodeCliVersion(options),
    probeOpenCodeCliVersion(options)
  ])
  expect(results[0].pluginApi).toBe('v1')
  expect(runProcess).toHaveBeenCalledTimes(1)
  await probeOpenCodeCliVersion({ ...options, executablePath: '/other/opencode' })
  await probeOpenCodeCliVersion({ ...options, hostIdentity: 'wsl:ubuntu' })
  await probeOpenCodeCliVersion({ ...options, env: { ...options.env, XDG_CONFIG_HOME: '/two' } })
  expect(runProcess).toHaveBeenCalledTimes(4)
  expect(runProcess).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['--version'], timeoutMs: 5_000, maxOutputBytes: 4_096 })
  )
})

it('degrades timeouts and missing executables to unknown', async () => {
  vi.mocked(runProcess).mockResolvedValueOnce({
    code: null,
    signal: 'SIGTERM',
    stdout: '2.0.16',
    stderr: '',
    timedOut: true
  })
  expect(
    (await probeOpenCodeCliVersion({ executablePath: '/timeout/opencode', env: {} })).pluginApi
  ).toBe('unknown')
  vi.mocked(runProcess).mockRejectedValueOnce(new Error('ENOENT'))
  expect(
    (await probeOpenCodeCliVersion({ executablePath: '/missing/opencode', env: {} })).version
  ).toBeNull()
})

it('shares a bounded execution-host callback without probing the native machine', async () => {
  const execute = vi
    .fn()
    .mockResolvedValue({ code: 0, timedOut: false, stdout: 'opencode v2.0.16' })
  const options = { executablePath: 'opencode', env: {}, hostIdentity: 'wsl:private', execute }
  const results = await Promise.all([
    probeOpenCodeCliVersion(options),
    probeOpenCodeCliVersion(options)
  ])
  expect(results[0].promptMode).toBe('prefill')
  expect(execute).toHaveBeenCalledTimes(1)
  expect(runProcess).not.toHaveBeenCalled()
})
