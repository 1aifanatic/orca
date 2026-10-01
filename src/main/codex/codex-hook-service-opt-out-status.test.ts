import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./codex-hook-local-maintenance', () => ({
  refreshCodexRuntimeUserHooksExclusively: vi.fn(),
  removeCodexHooksExclusively: async (getStatus: () => unknown) => getStatus()
}))
vi.mock('./codex-hook-trust-queue', () => ({
  runExclusivelyForRuntimeAndSystemTrustConfig: (_home: string, run: () => unknown) => run()
}))

import { CodexHookService } from './codex-hook-service-implementation'
import { listCodexHookFlagEntries, publishCodexHookFlagEntry } from './codex-hook-flag-table'

describe('Codex hook status after the opt-out', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-hook-opt-out-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
  })

  it('reads the published table, so a separate CLI process reports what the app published', () => {
    const service = new CodexHookService()
    expect(service.getStatus().state).toBe('not_installed')

    publishCodexHookFlagEntry({ codexVersion: 'codex-cli 1.0.0', flag: 'hooks={}', noDaemon: true })

    expect(new CodexHookService().getStatus()).toMatchObject({
      state: 'installed',
      detail: 'Carried as a session flag for codex-cli 1.0.0'
    })
  })

  it('empties the table on opt-out, so open panes stop carrying at their next launch', async () => {
    publishCodexHookFlagEntry({ codexVersion: 'codex-cli 1.0.0', flag: 'hooks={}', noDaemon: true })
    const service = new CodexHookService()

    const status = await service.remove()

    expect(status.state).toBe('not_installed')
    expect(listCodexHookFlagEntries()).toEqual([])
  })
})
