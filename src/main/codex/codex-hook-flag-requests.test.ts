import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handleCodexHookFlagRequest: vi.fn(),
  clearCodexHookSessionFlags: vi.fn()
}))

vi.mock('./codex-hook-session-trust', () => mocks)
vi.mock('./codex-cmd-hook-flag-gate', () => ({ ensureCodexCmdHookFlagGate: () => {} }))

import { startCodexHookFlagRequests } from './codex-hook-flag-requests'
import { getCodexHookFlagTablePath, requestCodexHookFlagEntry } from './codex-hook-flag-table'

describe('Codex hook flag requests', () => {
  let userData: string
  let stop: () => void = () => {}

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-requests-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    mocks.handleCodexHookFlagRequest.mockReset()
    mocks.clearCodexHookSessionFlags.mockReset()
  })

  afterEach(() => {
    stop()
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
  })

  it('serves a request a launch writes while Orca runs', async () => {
    stop = startCodexHookFlagRequests({ isEnabled: () => true })
    const table = getCodexHookFlagTablePath()

    // Why a shell's own write: the carrier writes this file, not Orca's helper.
    writeFileSync(join(table, 'codex-cli 0.160.0.request'), '/usr/local/bin/codex\n')

    // Why a long bound: file-watch delivery lags on a loaded machine.
    await vi.waitFor(
      () =>
        expect(mocks.handleCodexHookFlagRequest).toHaveBeenCalledWith({
          codexVersion: 'codex-cli 0.160.0',
          codexPath: '/usr/local/bin/codex'
        }),
      { timeout: 10_000 }
    )
    expect(readdirSync(table)).toEqual([])
  })

  it('serves requests left while Orca was closed, at start', () => {
    const table = getCodexHookFlagTablePath()
    stop = startCodexHookFlagRequests({ isEnabled: () => true })
    stop()
    requestCodexHookFlagEntry('codex-cli 0.159.2', '/opt/codex')

    stop = startCodexHookFlagRequests({ isEnabled: () => true })

    expect(mocks.handleCodexHookFlagRequest).toHaveBeenCalledWith({
      codexVersion: 'codex-cli 0.159.2',
      codexPath: '/opt/codex'
    })
    expect(existsSync(join(table, 'codex-cli 0.159.2.request'))).toBe(false)
  })

  it('drops requests without deriving while Codex hooks are off, and clears the table at start', () => {
    const table = getCodexHookFlagTablePath()
    stop = startCodexHookFlagRequests({ isEnabled: () => true })
    stop()
    requestCodexHookFlagEntry('codex-cli 0.159.2', '/opt/codex')

    stop = startCodexHookFlagRequests({ isEnabled: () => false })

    expect(mocks.clearCodexHookSessionFlags).toHaveBeenCalled()
    expect(mocks.handleCodexHookFlagRequest).not.toHaveBeenCalled()
    expect(existsSync(join(table, 'codex-cli 0.159.2.request'))).toBe(false)
  })
})
