import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as InstallLock from '../agent-hooks/managed-hook-install-lock'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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
// Why: a bare `codex` has no binary stamp, so no real binary is ever stat'ed.
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('../agent-hooks/managed-hook-install-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallLock>()
  return { withManagedHookInstallLock: vi.fn(actual.withManagedHookInstallLock) }
})

import { withManagedHookInstallLock } from '../agent-hooks/managed-hook-install-lock'
import { ensureRealHomeCodexHookState, _internals } from './codex-real-home-hook-install'
import type { CodexManagedTrustGrantPlan } from './codex-hook-trust-grant'
import {
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  upsertHookTrustEntries
} from './config-toml-trust'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { writeCodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import { getManagedScriptPath } from './codex-hook-definition'

let homeDir: string
let userDataDir: string

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'orca-real-home-write-lock-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-real-home-write-lock-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataDir)
  homedirMock.mockReturnValue(homeDir)
  mkdirSync(join(homeDir, '.codex'), { recursive: true })
  _internals.setLaneForTesting('pending')
  // Like a real grant: Codex writes the trust, and Orca records it in the ledger.
  grantMock.mockImplementation((plan: CodexManagedTrustGrantPlan) => {
    const entries = plan.managedEntries.map((entry) => ({ ...entry, trustedHash: 'codex-hash' }))
    upsertHookTrustEntries(plan.tomlPath, entries)
    writeCodexTrustGrantLedgerHome(plan.runtimeHomePath, {
      binary: null,
      entries: Object.fromEntries(
        entries.map((entry) => [
          normalizeHookTrustKeyForLookup(computeTrustKey(entry)),
          { signature: getCodexHookTrustSignature(entry), trustedHash: 'codex-hash' }
        ])
      )
    })
    return { lane: 'rpc', entries }
  })
  vi.mocked(withManagedHookInstallLock).mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  grantMock.mockReset()
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

// Why: a dev and a packaged Orca on one HOME both mutate ~/.codex; one's write
// must not land inside the other's capture->restore window.
it('waits for another holder of the real-home lock before writing ~/.codex', async () => {
  const hooksJsonPath = join(homeDir, '.codex', 'hooks.json')
  let releaseOther!: () => void
  const otherHeld = new Promise<void>((resolve) => {
    releaseOther = resolve
  })
  let otherAcquired!: () => void
  const acquired = new Promise<void>((resolve) => {
    otherAcquired = resolve
  })
  const other = withManagedHookInstallLock(homeDir, undefined, async () => {
    otherAcquired()
    await otherHeld
  })
  await acquired

  const ensure = ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
  await delay(300)
  expect(existsSync(hooksJsonPath)).toBe(false)

  releaseOther()
  await other
  await expect(ensure).resolves.toBe('installed')
  expect(existsSync(hooksJsonPath)).toBe(true)
})

// Why: every pane spawn on this lane reaches the ensure; one that writes
// nothing must not probe the lock owner or wait behind another instance.
it('takes no lock once the real home already holds the trusted entry', async () => {
  const hooksJsonPath = join(homeDir, '.codex', 'hooks.json')
  await expect(
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
  ).resolves.toBe('installed')
  expect(withManagedHookInstallLock).toHaveBeenCalled()
  vi.mocked(withManagedHookInstallLock).mockClear()
  grantMock.mockClear()
  const before = {
    bytes: readFileSync(hooksJsonPath, 'utf-8'),
    mtimeMs: statSync(hooksJsonPath).mtimeMs
  }

  await expect(
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
  ).resolves.toBe('installed')

  expect(withManagedHookInstallLock).not.toHaveBeenCalled()
  expect(grantMock).not.toHaveBeenCalled()
  expect({
    bytes: readFileSync(hooksJsonPath, 'utf-8'),
    mtimeMs: statSync(hooksJsonPath).mtimeMs
  }).toEqual(before)
})

// Why: the ops escape hatch must keep the managed lane even after a grant was recorded.
it('leaves the real-home lane when the trust RPC is disabled after a recorded grant', async () => {
  await expect(
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
  ).resolves.toBe('installed')
  vi.stubEnv('ORCA_DISABLE_CODEX_TRUST_RPC', '1')
  grantMock.mockReturnValue({ lane: 'fallback', reason: 'disabled' })

  await expect(
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
  ).resolves.toBe('unavailable')
})

it('re-reads under the lock, keeping a save made while it waited', async () => {
  const hooksJsonPath = join(homeDir, '.codex', 'hooks.json')
  const savedMeanwhile = { type: 'command', command: 'saved-meanwhile.sh' }
  let releaseOther!: () => void
  const otherHeld = new Promise<void>((resolve) => {
    releaseOther = resolve
  })
  let otherAcquired!: () => void
  const acquired = new Promise<void>((resolve) => {
    otherAcquired = resolve
  })
  const other = withManagedHookInstallLock(homeDir, undefined, async () => {
    otherAcquired()
    await otherHeld
  })
  await acquired

  const ensure = ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
  await delay(300)
  // Another instance writes ~/.codex while it holds the lock.
  writeFileSync(
    hooksJsonPath,
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [savedMeanwhile] }] } }, null, 2)}\n`
  )
  releaseOther()
  await other

  await expect(ensure).resolves.toBe('installed')
  const stop = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')).hooks.Stop
  expect(stop[0]).toEqual({ hooks: [savedMeanwhile] })
  expect(stop).toHaveLength(2)
})

// Why: the POSIX hook guard skips a script that is not executable, so a script
// with the right bytes but no exec bit is not the steady state.
it.skipIf(process.platform === 'win32')(
  'restores the shared script exec bit even when its bytes match',
  async () => {
    await expect(
      ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
    ).resolves.toBe('installed')
    chmodSync(getManagedScriptPath(), 0o644)

    await expect(
      ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
    ).resolves.toBe('installed')

    expect(statSync(getManagedScriptPath()).mode & 0o777).toBe(0o755)
  }
)
