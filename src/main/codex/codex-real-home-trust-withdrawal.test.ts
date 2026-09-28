import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand, type HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexManagedTrustGrantPlan } from './codex-hook-trust-grant'
import { computeTrustedHash, upsertHookTrustEntries } from './config-toml-trust'

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
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { _internals as rebaseInternals } from './codex-user-hook-trust-rebase'

// Why these tests: a failed trust session withdraws only what that call wrote and
// is still untrusted. Every Orca on this HOME shares the file, so anything else
// in it, including an identical entry another Orca trusted, must survive.

let homeDir: string
let userDataDir: string
const SAVED_MEANWHILE = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'saved-meanwhile.sh' }] }] } }, null, 2)}\n`

function hooksJsonPath(): string {
  return join(homeDir, '.codex', 'hooks.json')
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'orca-real-home-withdrawal-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-real-home-withdrawal-user-data-'))
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
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
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

  await expect(cleanupLegacySystemManagedHooks()).resolves.toBeUndefined()

  expect(operations).toEqual(['inspect-user-hook-trust', 'repair-user-hook-trust'])
  expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(SAVED_MEANWHILE)
})

type HooksFile = { hooks: Record<string, HookDefinition[]> }

function readHooks(): HooksFile {
  return JSON.parse(readFileSync(hooksJsonPath(), 'utf-8'))
}

function writeHooks(file: HooksFile): string {
  const raw = `${JSON.stringify(file, null, 2)}\n`
  writeFileSync(hooksJsonPath(), raw)
  return raw
}

function orcaCommands(file: HooksFile): string[] {
  const { command } = getCodexManagedHookInstallMaterial()
  return Object.values(file.hooks)
    .flat()
    .flatMap((definition) => definition.hooks ?? [])
    .map((hook) => hook.command)
    .filter((candidate) => candidate === command)
}

const userHook = (command: string) => ({ hooks: [{ type: 'command' as const, command }] })

it('withdraws only what the failed call added; adds made during the session survive', async () => {
  writeHooks({ hooks: { Stop: [userHook('before.sh')] } })
  grantMock.mockImplementation(() => {
    const file = readHooks()
    file.hooks.Stop!.push(userHook('appended-during-session.sh'))
    file.hooks.PreCompact = [userHook('added-during-session.sh')]
    writeHooks(file)
    return { lane: 'fallback', reason: 'error' }
  })

  expect(
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
  ).toBe('unavailable')

  expect(readHooks()).toEqual({
    hooks: {
      Stop: [userHook('before.sh'), userHook('appended-during-session.sh')],
      PreCompact: [userHook('added-during-session.sh')]
    }
  })
})

it('keeps an entry another Orca trusted during the failed session', async () => {
  grantMock.mockImplementation((plan: CodexManagedTrustGrantPlan) => {
    const stop = plan.managedEntries.find((entry) => entry.eventLabel === 'stop')!
    upsertHookTrustEntries(join(homeDir, '.codex', 'config.toml'), [
      { ...stop, trustedHash: computeTrustedHash(stop) }
    ])
    return { lane: 'fallback', reason: 'error' }
  })

  expect(
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
  ).toBe('unavailable')

  const file = readHooks()
  expect(Object.keys(file.hooks)).toEqual(['Stop'])
  expect(orcaCommands(file)).toHaveLength(1)
})

it.skipIf(process.platform === 'win32')(
  "puts an older build's entry back in its slot when the one-time conversion cannot be trusted",
  async () => {
    const older = wrapPosixHookCommand(join(homeDir, '.orca', 'agent-hooks', 'codex-hook.sh'))
    const { events } = getCodexManagedHookInstallMaterial()
    const original = writeHooks({
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [{ hooks: [{ type: 'command', command: older, timeout: 10 }] }, userHook('after.sh')]
        ])
      )
    })
    grantMock.mockReturnValue({ lane: 'fallback', reason: 'error' })

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'convert-older-forms'
      })
    ).toBe('unavailable')

    expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(original)
  }
)
