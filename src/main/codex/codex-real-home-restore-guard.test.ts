import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
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
  grantManagedCodexHookTrust: grantMock
}))

import { ensureRealHomeCodexHookState, _internals } from './codex-real-home-hook-install'
import { cleanupLegacySystemManagedHooks } from './codex-hook-legacy-cleanup'
import { _internals as rebaseInternals } from './codex-user-hook-trust-rebase'

// Why these tests: Orca restores a real-home file seconds after writing it, once
// a trust session fails. A save that lands in between must survive that restore.

let homeDir: string
let userDataDir: string
const SAVED_MEANWHILE = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'saved-meanwhile.sh' }] }] } }, null, 2)}\n`

function hooksJsonPath(): string {
  return join(homeDir, '.codex', 'hooks.json')
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'orca-real-home-restore-guard-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-real-home-restore-guard-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataDir)
  homedirMock.mockReturnValue(homeDir)
  mkdirSync(join(homeDir, '.codex'), { recursive: true })
  _internals.setLaneForTesting('pending')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  rebaseInternals.setSessionRunner(null)
  rebaseInternals.resetRetryState()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  grantMock.mockReset()
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

it('keeps a hooks.json save that lands during a failed real-home grant', async () => {
  writeFileSync(hooksJsonPath(), `${JSON.stringify({ hooks: {} }, null, 2)}\n`)
  grantMock.mockImplementation(() => {
    writeFileSync(hooksJsonPath(), SAVED_MEANWHILE)
    return { lane: 'fallback', reason: 'error' }
  })

  expect(
    await ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
  ).toBe('unavailable')

  expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(SAVED_MEANWHILE)
})

it('keeps a hooks.json save that lands during a failed legacy-sweep trust repair', async () => {
  // Why a retired form (#1536): the sweep never removes the current entry.
  const quoted = `'${join(homeDir, '.orca', 'agent-hooks', 'codex-hook.sh')}'`
  const legacyCommand =
    process.platform === 'win32'
      ? join(userDataDir, 'agent-hooks', 'codex-hook.cmd')
      : `if [ -x ${quoted} ]; then /bin/sh ${quoted}; fi`
  writeFileSync(
    hooksJsonPath(),
    `${JSON.stringify(
      {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: legacyCommand }] },
            { hooks: [{ type: 'command', command: 'user-hook.sh' }] }
          ]
        }
      },
      null,
      2
    )}\n`
  )
  const operations: string[] = []
  rebaseInternals.setSessionRunner(async (request) => {
    operations.push(request.operation)
    if (request.operation === 'inspect-user-hook-trust') {
      return {
        outcome: 'inspected',
        moves: request.moves.map((move) => ({
          ...move,
          reportedOldKey: move.oldKey,
          wasTrusted: true,
          enabled: true
        }))
      }
    }
    writeFileSync(hooksJsonPath(), SAVED_MEANWHILE)
    throw new Error('repair failed')
  })

  await expect(cleanupLegacySystemManagedHooks()).rejects.toThrow('repair failed')

  expect(operations).toEqual(['inspect-user-hook-trust', 'repair-user-hook-trust'])
  expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(SAVED_MEANWHILE)
})
