import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createStore,
  getRuntimeCodexAuthPath,
  getSharedRuntimeAuthProvenancePath,
  getSystemCodexAuthPath,
  setRealHomeRoutableForTest,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'
import { RETIRED_MIRROR_CARRY_MARKER } from './retired-mirror-carry'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import type { GlobalSettings } from '../../shared/global-settings-types'

vi.mock('../codex/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function getMarkerPath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', RETIRED_MIRROR_CARRY_MARKER)
}

async function createService(settings: GlobalSettings): Promise<CodexRuntimeHomeService> {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only getSettings/updateSettings, which the harness store implements.
  return new CodexRuntimeHomeService(createStore(settings) as never)
}

async function upgradeToRealHome(platform: NodeJS.Platform): Promise<string | null> {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  setRealHomeRoutableForTest(true)
  const service = await createService(createSettings({ realHomeRoutable: true }))
  return service.prepareForCodexLaunch()
}

async function startOnMirror(): Promise<void> {
  await createService(createSettings())
}

describe('retiring the Windows system-default mirror', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    teardownRuntimeHomeTest()
  })

  it('carries a login made inside an Orca pane into ~/.codex, once', async () => {
    await startOnMirror()
    const paneLogin = createCodexAuthJson('me@example.com', 'acct-me', 'pane-login')
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')

    expect(await upgradeToRealHome('win32')).toBeNull()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(paneLogin)
    expect(JSON.parse(readFileSync(getSharedRuntimeAuthProvenancePath(), 'utf-8'))).toEqual({
      owner: 'system-default',
      authJson: paneLogin
    })
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('carries a login made in a pane that opened while the hook approval ran', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const service = await createService(createSettings({ realHomeRoutable: true }))
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(existsSync(getMarkerPath())).toBe(true)

    let approving = true
    service.setRealHomeLaneGate(() => !approving)
    expect(service.prepareForCodexLaunch()).not.toBeNull()
    const paneLogin = createCodexAuthJson('me@example.com', 'acct-me', 'approval-window')
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')
    approving = false

    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(paneLogin)
  })

  it('does not undo a logout from ~/.codex', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'system'),
      'utf-8'
    )
    await startOnMirror()
    rmSync(getSystemCodexAuthPath())

    await upgradeToRealHome('win32')

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('leaves macOS and Linux homes alone; they retired the mirror long ago', async () => {
    await startOnMirror()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'stale'),
      'utf-8'
    )

    await upgradeToRealHome('darwin')

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
    expect(existsSync(getMarkerPath())).toBe(false)
  })
})
