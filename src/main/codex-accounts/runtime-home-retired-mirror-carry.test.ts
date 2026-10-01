import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createStore,
  getRuntimeCodexAuthPath,
  getRuntimeCodexHomePath,
  getSharedRuntimeAuthProvenancePath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
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

async function upgradeToRealHome(
  platform: NodeJS.Platform = 'win32'
): Promise<CodexRuntimeHomeService> {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  const service = await createService(createSettings({ realHomeRoutable: true }))
  expect(service.prepareForCodexLaunch()).toBeNull()
  return service
}

async function launchOnMirror(): Promise<void> {
  const service = await createService(createSettings())
  expect(service.prepareForCodexLaunch()).not.toBeNull()
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

  it('carries a login and MCP credentials made inside an Orca pane into ~/.codex', async () => {
    await launchOnMirror()
    const paneLogin = createCodexAuthJson('me@example.com', 'acct-me', 'pane-login')
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')
    writeFileSync(join(getRuntimeCodexHomePath(), '.credentials.json'), 'mcp-oauth', 'utf-8')

    await upgradeToRealHome()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(paneLogin)
    expect(readFileSync(join(getSystemCodexHomePath(), '.credentials.json'), 'utf-8')).toBe(
      'mcp-oauth'
    )
    expect(JSON.parse(readFileSync(getSharedRuntimeAuthProvenancePath(), 'utf-8'))).toEqual({
      owner: 'system-default',
      authJson: paneLogin
    })
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('carries a token the mirror refreshed for the account ~/.codex holds', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'seeded'),
      'utf-8'
    )
    await launchOnMirror()
    const refreshed = createCodexAuthJson('me@example.com', 'acct-me', 'refreshed')
    writeFileSync(getRuntimeCodexAuthPath(), refreshed, 'utf-8')

    await upgradeToRealHome()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshed)
  })

  it('keeps a login ~/.codex gained after seeding the mirror', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'seeded'),
      'utf-8'
    )
    await launchOnMirror()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'mirror-refresh'),
      'utf-8'
    )
    const newerLogin = createCodexAuthJson('me@example.com', 'acct-me', 'newer-in-codex-home')
    writeFileSync(getSystemCodexAuthPath(), newerLogin, 'utf-8')

    await upgradeToRealHome()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(newerLogin)
  })

  it('does not undo a logout from ~/.codex', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'system'),
      'utf-8'
    )
    await launchOnMirror()
    rmSync(getSystemCodexAuthPath())

    await upgradeToRealHome()

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('leaves credentials it cannot attribute to the system default in the mirror', async () => {
    await launchOnMirror()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed'),
      'utf-8'
    )
    writeFileSync(join(getRuntimeCodexHomePath(), '.credentials.json'), 'managed-mcp', 'utf-8')
    writeFileSync(getSharedRuntimeAuthProvenancePath(), '{"owner":"pending"}\n')

    await upgradeToRealHome()

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
    expect(existsSync(join(getSystemCodexHomePath(), '.credentials.json'))).toBe(false)
  })

  it('runs once: a later mirror-lane launch does not reopen the migration', async () => {
    await launchOnMirror()
    const service = await upgradeToRealHome()
    expect(existsSync(getMarkerPath())).toBe(true)

    setRealHomeRoutableForTest(false)
    expect(service.prepareForCodexLaunch()).not.toBeNull()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'later-pane-login'),
      'utf-8'
    )
    setRealHomeRoutableForTest(true)
    expect(service.prepareForCodexLaunch()).toBeNull()

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
  })

  it('leaves macOS and Linux homes alone; they retired the mirror long ago', async () => {
    await launchOnMirror()
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
