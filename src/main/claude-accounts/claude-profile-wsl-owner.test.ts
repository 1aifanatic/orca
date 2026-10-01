import { it, expect, vi, afterEach } from 'vitest'
import { createWslClaudeProfileOwner, type ClaudeProfileSettings } from './claude-profile-wsl-owner'
import { ClaudeProfileRoutingService } from './claude-profile-routing-service'
import type { ClaudeWslProfileRequest } from './claude-profile-wsl-guest'
import { claudeProfileRoutingEnabled } from '../../shared/claude-profile-routing'
afterEach(() => vi.restoreAllMocks())
function fixture() {
  const settings: ClaudeProfileSettings = {
    claudeManagedAccounts: ['Ubuntu', 'Debian'].map((distro) => ({
      id: distro,
      email: 'fake@example.test',
      authMethod: 'subscription-oauth',
      managedAuthRuntime: 'wsl',
      wslDistro: distro,
      managedAuthPath: '/unused-legacy',
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    })),
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: {
      host: null,
      wsl: { Ubuntu: 'Ubuntu', Debian: 'Debian' }
    },
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const calls: ClaudeWslProfileRequest[] = []
  const prepare = vi.fn(async (distro: string) => ({
    home: `/home/${distro}`,
    request: async (request: ClaudeWslProfileRequest) => {
      calls.push(request)
      return {
        ready: true,
        provisioned: true,
        report: { outcome: 'prepared' as const, surfaces: {}, warnings: [] }
      }
    }
  }))
  return {
    settings,
    prepare,
    calls,
    routing: new ClaudeProfileRoutingService(
      createWslClaudeProfileOwner(
        () => settings,
        prepare,
        async (distro) => {
          calls.push({
            action: 'withdraw',
            distro,
            userHome: `/home/${distro}`,
            accountId: null,
            hooksEnabled: false
          })
        }
      )
    )
  }
}
it('keeps distro pointers, guest paths, startup and current selection separate', async () => {
  const f = fixture()
  await f.routing.startup()
  for (const distro of ['Ubuntu', 'Debian']) {
    const result = await f.routing.prepare({ runtime: 'wsl', wslDistro: distro })
    expect(result.envPatch.CLAUDE_CONFIG_DIR).toBe(
      `/home/${distro}/.local/share/orca/claude-profiles/${distro}/home`
    )
    expect(result.envPatch.ORCA_CLAUDE_PROFILE_POINTER).toBe(
      `/home/${distro}/.local/share/orca/claude-profiles/selected-wsl`
    )
    expect(result.configDir).toContain(`\\${distro}\\home\\${distro}`)
  }
  expect(f.calls.filter((request) => request.action === 'setup')).toHaveLength(2)
  expect(f.calls.filter((request) => request.action === 'publish')).toHaveLength(4)
  expect(claudeProfileRoutingEnabled()).toBe(false)
})
it('refuses runtime failure and withdraws only that distro pointer; retry can recover', async () => {
  const f = fixture()
  const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
  await f.routing.prepare(target)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001)
  f.prepare.mockRejectedValueOnce(new Error('runtime download failed'))
  await expect(f.routing.prepare(target)).rejects.toThrow('runtime download failed')
  expect(f.calls.at(-1)).toMatchObject({ action: 'withdraw', distro: 'Ubuntu' })
  expect(() => f.routing.resolve(target)).toThrow('has not provided')
  await expect(f.routing.prepare(target)).resolves.toHaveProperty('runtime', 'wsl')
})
it('rejects account/distro mismatches before touching a guest', async () => {
  const f = fixture()
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = 'Debian'
  await expect(f.routing.prepare({ runtime: 'wsl', wslDistro: 'Ubuntu' })).rejects.toThrow(
    'does not belong'
  )
  expect(f.prepare).not.toHaveBeenCalled()
})
it('continues initializing other distros when one is stopped, then reports the failure', async () => {
  const f = fixture()
  f.prepare.mockRejectedValueOnce(new Error('Ubuntu is not running'))
  await expect(f.routing.startup()).rejects.toThrow('not running')
  expect(
    f.calls.some((request) => request.action === 'publish' && request.distro === 'Debian')
  ).toBe(true)
  expect(f.calls.some((request) => request.action === 'setup' && request.distro === 'Ubuntu')).toBe(
    false
  )
})
