import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

import { withManagedHookInstallLock } from '../agent-hooks/managed-hook-install-lock'
import { ensureRealHomeCodexHookState, _internals } from './codex-real-home-hook-install'

let homeDir: string
let userDataDir: string

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'orca-real-home-write-lock-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-real-home-write-lock-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataDir)
  homedirMock.mockReturnValue(homeDir)
  mkdirSync(join(homeDir, '.codex'), { recursive: true })
  _internals.setLaneForTesting('pending')
  grantMock.mockImplementation((plan: { managedEntries: object[] }) => ({
    lane: 'rpc',
    entries: plan.managedEntries.map((entry) => ({ ...entry, trustedHash: 'codex-hash' }))
  }))
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
