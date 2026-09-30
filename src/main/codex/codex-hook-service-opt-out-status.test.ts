import { describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({
  current: { flag: 'hooks={}', codexVersion: 'codex-cli 1.0.0' } as unknown
}))

vi.mock('./codex-hook-session-trust', () => ({
  getCodexHookSessionFlags: () => flags.current,
  refreshCodexHookSessionFlags: vi.fn(),
  clearCodexHookSessionFlags: () => {
    flags.current = null
  }
}))
vi.mock('./codex-hook-local-maintenance', () => ({
  refreshCodexRuntimeUserHooksExclusively: vi.fn(),
  removeCodexHooksExclusively: async (getStatus: () => unknown) => getStatus()
}))

vi.mock('./codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: () => '/orca/codex-runtime-home'
}))
vi.mock('./codex-hook-trust-queue', () => ({
  runExclusivelyForRuntimeAndSystemTrustConfig: (_home: string, run: () => unknown) => run()
}))

import { CodexHookService } from './codex-hook-service-implementation'

describe('Codex hook status after the opt-out', () => {
  it('reads not installed once hooks are turned off, since launches carry no flag', async () => {
    const service = new CodexHookService()
    expect(service.getStatus().state).toBe('installed')

    const status = await service.remove()

    expect(status.state).toBe('not_installed')
    expect(service.getStatus().managedHooksPresent).toBe(false)
  })
})
