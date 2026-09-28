import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../index'

const { call } = vi.hoisted(() => ({ call: vi.fn(async () => ({ result: null })) }))
vi.mock('../runtime-client', () => ({
  RuntimeClient: class {
    call = call
  },
  RuntimeClientError: Error,
  getDefaultUserDataPath: () => '/unused/user-data'
}))
vi.mock('../../main/persistence/profile-state/profile-state-offline-settings', () => {
  throw new Error('Offline profile settings loaded during online preparation')
})
vi.mock('../../main/persistence/profile-state/profile-state-access', () => {
  throw new Error('Profile admission loaded during online preparation')
})
vi.mock('../profile-state-location', () => {
  throw new Error('Profile location loaded during online preparation')
})
vi.mock('../../main/codex/managed-home-shell-preflight', () => {
  throw new Error('The Codex installer loaded in the pane CLI')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
})

it('prepares Codex through the runtime without loading profile storage or an installer', async () => {
  vi.stubEnv('WSL_DISTRO_NAME', '')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await main(['agent', 'hooks', 'prepare-codex'])
  expect(error).not.toHaveBeenCalled()
  expect(call).toHaveBeenCalledWith('agentHooks.prepareCodexForPane', expect.any(Object), {
    timeoutMs: 50_000
  })
})
