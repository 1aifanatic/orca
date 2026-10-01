import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookSessionTrust from './codex-hook-session-trust'

const { removeCodexHooksExclusively, defaultVersion } = vi.hoisted(() => {
  const defaultVersion: { current: string | null } = { current: null }
  return {
    removeCodexHooksExclusively: vi.fn(async (getStatus: () => unknown) => getStatus()),
    defaultVersion
  }
})
vi.mock('./codex-hook-session-trust', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookSessionTrust>()),
  getDefaultCodexHookFlagVersion: () => defaultVersion.current
}))
vi.mock('./codex-hook-local-maintenance', () => ({
  refreshCodexRuntimeUserHooksExclusively: vi.fn(),
  removeCodexHooksExclusively
}))
vi.mock('./codex-hook-trust-queue', () => ({
  runExclusivelyForRuntimeAndSystemTrustConfig: (_home: string, run: () => unknown) => run()
}))

import { CodexHookService } from './codex-hook-service-implementation'
import {
  codexHookFlagTableExists,
  createCodexHookFlagTable,
  publishCodexHookFlagEntry
} from './codex-hook-flag-table'

describe('Codex hook status after the opt-out', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-hook-opt-out-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    defaultVersion.current = null
    createCodexHookFlagTable()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    const table = join(userData, 'codex-hook-flags')
    if (existsSync(table)) {
      chmodSync(table, 0o755)
    }
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

  it("reports the entry for this process's codex version, not one left by an older Codex", () => {
    publishCodexHookFlagEntry({ codexVersion: 'codex-cli 1.0.0', flag: 'hooks={}', noDaemon: true })

    defaultVersion.current = 'codex-cli 2.0.0'
    expect(new CodexHookService().getStatus().state).toBe('not_installed')

    defaultVersion.current = 'codex-cli 1.0.0'
    expect(new CodexHookService().getStatus()).toMatchObject({
      state: 'installed',
      detail: 'Carried as a session flag for codex-cli 1.0.0'
    })
  })

  it('removes the table on opt-out, so open panes run plain codex at their next launch', async () => {
    publishCodexHookFlagEntry({ codexVersion: 'codex-cli 1.0.0', flag: 'hooks={}', noDaemon: true })
    const service = new CodexHookService()

    const status = await service.remove()

    expect(status.state).toBe('not_installed')
    expect(codexHookFlagTableExists()).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'finishes the opt-out when the table cannot be removed',
    async () => {
      publishCodexHookFlagEntry({
        codexVersion: 'codex-cli 1.0.0',
        flag: 'hooks={}',
        noDaemon: true
      })
      // Why: a read-only table makes its rm fail, as a held file does on Windows.
      chmodSync(join(userData, 'codex-hook-flags'), 0o555)
      removeCodexHooksExclusively.mockClear()

      await expect(new CodexHookService().remove()).resolves.toBeDefined()

      expect(removeCodexHooksExclusively).toHaveBeenCalledOnce()
    }
  )
})
