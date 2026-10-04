import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

const { homedirMock, grantMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  grantMock: vi.fn()
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

vi.mock('./codex-hook-trust-grant', () => ({
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS: 300_000,
  findCurrentManagedCodexHookTrust: async () => null,
  grantManagedCodexHookTrust: grantMock
}))

import {
  ensureRealHomeCodexHookState,
  isRealHomeCodexHookLaneUsable,
  _internals
} from './codex-real-home-hook-install'

let fakeHomeDir: string
let userDataDir: string

/** Makes a default-home Codex resolve a different home than homedir(), as an isolated rig does. */
function divergeCodexDefaultHome(): void {
  if (process.platform === 'win32') {
    // Codex reads the profile known folder; this fake home is not it.
    vi.stubEnv('USERPROFILE', fakeHomeDir)
  } else if (process.platform === 'darwin') {
    // login(1) gives panes the account home, not this one.
    vi.stubEnv('HOME', fakeHomeDir)
  } else {
    // Codex treats an empty HOME as unset and falls back to the passwd entry.
    vi.stubEnv('HOME', '')
  }
}

function alignCodexDefaultHome(): void {
  if (process.platform === 'win32') {
    vi.stubEnv('USERPROFILE', undefined)
  } else if (process.platform === 'darwin') {
    vi.stubEnv('HOME', userInfo().homedir)
  } else {
    // Linux compares nothing but emptiness; containers may lack a passwd entry.
    vi.stubEnv('HOME', fakeHomeDir)
  }
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-real-home-mismatch-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-real-home-mismatch-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataDir)
  homedirMock.mockReturnValue(fakeHomeDir)
  mkdirSync(join(fakeHomeDir, '.codex'), { recursive: true })
  grantMock.mockImplementation(() => ({ lane: 'rpc', entries: [] }))
  _internals.resetForTesting('pending')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('real-home lane when Codex resolves a different default home', () => {
  it('writes nothing and never asks a default-home Codex for approval', async () => {
    divergeCodexDefaultHome()

    await expect(
      ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).resolves.toBe('unavailable')
    expect(await _internals.settledVerdictForTesting()).toBe('unavailable')

    expect(grantMock).not.toHaveBeenCalled()
    expect(existsSync(join(fakeHomeDir, '.codex', 'hooks.json'))).toBe(false)
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)
  })

  it('keeps launches on the managed lane before any check and with hooks off', async () => {
    divergeCodexDefaultHome()
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)

    _internals.resetForTesting('removed')
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)
  })

  it('routes to the real home as before when the homes agree', () => {
    alignCodexDefaultHome()
    expect(isRealHomeCodexHookLaneUsable()).toBe(true)
    _internals.resetForTesting('removed')
    expect(isRealHomeCodexHookLaneUsable()).toBe(true)
  })
})
