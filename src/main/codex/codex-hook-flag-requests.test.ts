import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookSessionTrust from './codex-hook-session-trust'

const mocks = vi.hoisted(() => ({ handleCodexHookFlagRequest: vi.fn() }))

vi.mock('./codex-hook-session-trust', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookSessionTrust>()),
  handleCodexHookFlagRequest: mocks.handleCodexHookFlagRequest
}))
vi.mock('./codex-cmd-hook-flag-gate', () => ({ ensureCodexCmdHookFlagGate: () => {} }))

import {
  closeCodexHookFlagTable,
  openCodexHookFlagTable,
  startCodexHookFlagRequests
} from './codex-hook-flag-requests'
import {
  createCodexHookFlagTable,
  getCodexHookFlagTablePath,
  requestCodexHookFlagEntry
} from './codex-hook-flag-table'

function writeLaunchRequest(version: string): void {
  // Why a raw write: the shell carrier writes this file, not Orca's helper.
  writeFileSync(join(getCodexHookFlagTablePath(), `${version}.request`), '/usr/local/bin/codex\n')
}

async function expectServed(version: string): Promise<void> {
  // Why a long bound: file-watch delivery lags on a loaded machine.
  await vi.waitFor(
    () =>
      expect(mocks.handleCodexHookFlagRequest).toHaveBeenCalledWith({
        codexVersion: version,
        codexPath: '/usr/local/bin/codex'
      }),
    { timeout: 10_000 }
  )
}

describe('Codex hook flag table lifecycle and requests', () => {
  let userData: string
  let stop: () => void = () => {}

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-requests-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    mocks.handleCodexHookFlagRequest.mockReset()
  })

  afterEach(() => {
    stop()
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
  })

  it('creates the table at start while Codex hooks are on, and serves a launch request', async () => {
    stop = startCodexHookFlagRequests({ isEnabled: () => true })
    expect(existsSync(getCodexHookFlagTablePath())).toBe(true)

    writeLaunchRequest('codex-cli 0.160.0')

    await expectServed('codex-cli 0.160.0')
    expect(existsSync(join(getCodexHookFlagTablePath(), 'codex-cli 0.160.0.request'))).toBe(false)
  })

  it('serves requests left while Orca was closed, at start', () => {
    createCodexHookFlagTable()
    requestCodexHookFlagEntry('codex-cli 0.159.2', '/opt/codex')

    stop = startCodexHookFlagRequests({ isEnabled: () => true })

    expect(mocks.handleCodexHookFlagRequest).toHaveBeenCalledWith({
      codexVersion: 'codex-cli 0.159.2',
      codexPath: '/opt/codex'
    })
  })

  it('removes the table at start while Codex hooks are off, so launches probe nothing', () => {
    createCodexHookFlagTable()
    requestCodexHookFlagEntry('codex-cli 0.159.2', '/opt/codex')

    stop = startCodexHookFlagRequests({ isEnabled: () => false })

    expect(existsSync(getCodexHookFlagTablePath())).toBe(false)
    expect(mocks.handleCodexHookFlagRequest).not.toHaveBeenCalled()
  })

  it('watches the table again when hooks turn back on after the opt-out removed it', async () => {
    let enabled = true
    stop = startCodexHookFlagRequests({ isEnabled: () => enabled })
    enabled = false
    closeCodexHookFlagTable()
    expect(existsSync(getCodexHookFlagTablePath())).toBe(false)

    enabled = true
    openCodexHookFlagTable()
    writeLaunchRequest('codex-cli 0.160.0')

    await expectServed('codex-cli 0.160.0')
  })
})
