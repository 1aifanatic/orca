import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getOpenCodeCliCapabilities } from '../../shared/opencode-cli-version'
import { prepareOpenCodePtyLaunch } from './opencode-pty-launch'

const probe = vi.hoisted(() => vi.fn())
vi.mock('./opencode-launch-capabilities', () => ({ probeOpenCodeLaunchCapabilities: probe }))

beforeEach(() => probe.mockReset())

describe('execution-host OpenCode launch preparation', () => {
  it.each(['1.1.23', '2.0.16'])(
    'selects the probed %s plugin for the execution host',
    async (version) => {
      const capabilities = getOpenCodeCliCapabilities(version)
      probe.mockResolvedValue(capabilities)
      const env = {
        KEEP: '1',
        ORCA_OPENCODE_PLUGIN_API: 'stale'
      }
      const result = await prepareOpenCodePtyLaunch({
        command: 'opencode --prompt test',
        agent: 'opencode',
        env,
        cwd: '/repo',
        isFreshLaunch: true
      })
      expect(result).toEqual({ KEEP: '1', ORCA_OPENCODE_PLUGIN_API: capabilities.pluginApi })
      expect(env).toEqual({ KEEP: '1', ORCA_OPENCODE_PLUGIN_API: 'stale' })
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'opencode --prompt test',
          cwd: '/repo',
          env: expect.objectContaining({ KEEP: '1' })
        })
      )
    }
  )

  it('creates a launch environment for a known binary without caller env', async () => {
    probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
    expect(
      await prepareOpenCodePtyLaunch({ command: 'opencode', env: undefined, isFreshLaunch: true })
    ).toEqual({ ORCA_OPENCODE_PLUGIN_API: 'v2' })
  })

  it('forwards WSL plugin selection through WSLENV after a guest probe', async () => {
    probe.mockResolvedValue(getOpenCodeCliCapabilities('1.1.23'))
    const env = { KEEP: '1' }
    const result = await prepareOpenCodePtyLaunch({
      command: 'opencode',
      agent: 'opencode',
      env,
      isFreshLaunch: true,
      wsl: { distro: 'Ubuntu' }
    })
    expect(result).toMatchObject({
      ORCA_OPENCODE_PLUGIN_API: 'v1',
      WSLENV: 'ORCA_OPENCODE_PLUGIN_API'
    })
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ wsl: { distro: 'Ubuntu' } }))
  })

  it.each([{ connectionId: 'remote', isFreshLaunch: true }, { isFreshLaunch: false }])(
    'never probes the client for an attach or SSH launch',
    async (route) => {
      const env = { ORCA_OPENCODE_PLUGIN_API: 'v1' }
      expect(await prepareOpenCodePtyLaunch({ command: 'opencode', env, ...route })).toEqual({})
      expect(probe).not.toHaveBeenCalled()
      expect(env).toEqual({ ORCA_OPENCODE_PLUGIN_API: 'v1' })
    }
  )
})
