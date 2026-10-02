import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getOpenCodeLaunchExecutable,
  probeOpenCodeLaunchCapabilities
} from './opencode-launch-capabilities'
import { getOpenCodeCliCapabilities } from '../../shared/opencode-cli-version'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), probe: vi.fn(), wsl: vi.fn() }))
vi.mock('../ipc/command-path-resolver', () => ({ resolveCommandOnLocalPath: mocks.resolve }))
vi.mock('./opencode-cli-version', () => ({ probeOpenCodeCliVersion: mocks.probe }))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.wsl }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
})

describe('OpenCode execution-host launch capability probe', () => {
  it('recognizes quoted executables and preserves explicit run commands', () => {
    expect(getOpenCodeLaunchExecutable('"/app dir/opencode" run task')).toBe('/app dir/opencode')
    expect(getOpenCodeLaunchExecutable('custom-launcher --standalone', 'opencode')).toBe(
      'custom-launcher'
    )
    expect(getOpenCodeLaunchExecutable('claude')).toBeNull()
  })

  it('uses native resolution with the execution environment and cwd', async () => {
    mocks.resolve.mockResolvedValue('/bin/opencode')
    const env = { PATH: '/bin', OPENCODE_CONFIG_DIR: '/private/config' }
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode run task',
      env,
      cwd: '/repo',
      hostIdentity: 'native-test'
    })
    expect(mocks.resolve).toHaveBeenCalledWith('opencode', { env, cwd: '/repo' })
    expect(mocks.probe).toHaveBeenCalledWith({
      executablePath: '/bin/opencode',
      env,
      cwd: '/repo',
      hostIdentity: 'native-test'
    })
    expect(mocks.wsl).not.toHaveBeenCalled()
  })

  it('uses the relay resolver rather than client PATH resolution', async () => {
    const resolveExecutable = vi.fn().mockResolvedValue('/host/opencode')
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode',
      env: {},
      hostIdentity: 'relay:linux',
      resolveExecutable
    })
    expect(resolveExecutable).toHaveBeenCalledWith('opencode')
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/host/opencode', hostIdentity: 'relay:linux' })
    )
  })

  it('returns unknown when the host cannot resolve the binary', async () => {
    mocks.resolve.mockResolvedValue(null)
    expect(await probeOpenCodeLaunchCapabilities({ command: 'opencode', env: {} })).toEqual(
      getOpenCodeCliCapabilities(null)
    )
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it('bounds and scopes WSL probes to the guest distro without native PATH or HOME', async () => {
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode --standalone',
      env: { HOME: '/native', PATH: '/native/bin', OPENCODE_CONFIG_DIR: '/guest/config' },
      wsl: { distro: 'Ubuntu' },
      hostIdentity: 'host-a'
    })
    expect(mocks.resolve).not.toHaveBeenCalled()
    const options = mocks.probe.mock.calls[0]?.[0]
    expect(options).toEqual(
      expect.objectContaining({
        executablePath: 'opencode',
        hostIdentity: 'host-a:wsl:Ubuntu',
        env: { OPENCODE_CONFIG_DIR: '/guest/config' }
      })
    )
    await options.execute()
    expect(mocks.wsl).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      loginPath: 'preferred',
      program: 'opencode',
      args: ['--version'],
      env: { OPENCODE_CONFIG_DIR: '/guest/config' },
      timeoutMs: 5000,
      maxOutputBytes: 4096
    })
  })
})
