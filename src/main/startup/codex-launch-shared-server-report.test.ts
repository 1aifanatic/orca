import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepareForCodexLaunchAsync: vi.fn(),
  isHostSystemDefaultRealHomeSelected: vi.fn(() => false),
  prepareRuntimeHomeForLaunch: vi.fn(async () => ({ state: 'ok' as const })),
  reportCodexSharedServerInOwnedHome: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-user-data') } }))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: async () => {} }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: mocks.prepareRuntimeHomeForLaunch }
}))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  ensureRealHomeCodexHookState: async () => {}
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: () => false
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu' }))
vi.mock('../codex/codex-shared-server-probe', () => ({
  reportCodexSharedServerInOwnedHome: mocks.reportCodexSharedServerInOwnedHome
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      prepareForCodexLaunchAsync: mocks.prepareForCodexLaunchAsync,
      isHostSystemDefaultRealHomeSelected: mocks.isHostSystemDefaultRealHomeSelected
    },
    store: { getSettings: () => ({}) }
  }
}))

import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'

const OWNED_HOME = '/tmp/orca-user-data/codex-runtime-home/home'

describe('Codex launch prep shared-server report', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isHostSystemDefaultRealHomeSelected.mockReturnValue(false)
  })

  it('reports for the owned home without waiting on the check', async () => {
    // A check that never settles must not hold the spawn that awaits launch prep.
    mocks.reportCodexSharedServerInOwnedHome.mockReturnValue(new Promise(() => {}))
    mocks.prepareForCodexLaunchAsync.mockResolvedValue(OWNED_HOME)

    await expect(prepareCodexRuntimeHomeForLaunch()).resolves.toBe(OWNED_HOME)
    expect(mocks.reportCodexSharedServerInOwnedHome).toHaveBeenCalledWith(OWNED_HOME)
    expect(mocks.prepareRuntimeHomeForLaunch).toHaveBeenCalled()
  })

  it("never checks the user's own ~/.codex lane or a WSL launch", async () => {
    mocks.prepareForCodexLaunchAsync.mockResolvedValue(null)
    await expect(prepareCodexRuntimeHomeForLaunch()).resolves.toBeNull()

    mocks.prepareForCodexLaunchAsync.mockResolvedValue(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.local\\share\\orca\\codex-accounts\\a\\home'
    )
    await prepareCodexRuntimeHomeForLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(mocks.reportCodexSharedServerInOwnedHome).not.toHaveBeenCalled()
  })
})
