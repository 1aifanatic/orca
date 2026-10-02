import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  getRuntimeCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'

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
const MIRROR_ONLY_MCP_SERVER = '\n[mcp_servers.orca_only]\ncommand = "orca-only"\n'
// Why: Codex records folder trust in config.toml, which is what stays behind.
const MIRROR_FOLDER_TRUST = '\n[projects."C:\\\\repo"]\ntrust_level = "trusted"\n'
let ui: Partial<PersistedUIState>

async function createService(settings: GlobalSettings): Promise<CodexRuntimeHomeService> {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only settings and UI state, which the harness store implements.
  return new CodexRuntimeHomeService(createStore(settings, ui) as never)
}

async function launchOnMirror(config: string): Promise<void> {
  const service = await createService(createSettings())
  expect(service.prepareForCodexLaunch()).not.toBeNull()
  appendMirrorConfig(config)
}

async function launchOnRealHome(platform: NodeJS.Platform = 'win32'): Promise<void> {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  const service = await createService(createSettings({ realHomeRoutable: true }))
  expect(service.prepareForCodexLaunch()).toBeNull()
}

function appendMirrorConfig(config: string): void {
  appendFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), config)
}

describe('the notice for Windows Codex moving onto ~/.codex', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
    ui = {}
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    teardownRuntimeHomeTest()
  })

  it('records the MCP servers left behind when Codex had run in Orca', async () => {
    await launchOnMirror(MIRROR_ONLY_MCP_SERVER)

    await launchOnRealHome()

    expect(ui.codexSharedSettingsNotice).toEqual({ mcpServerNames: ['orca_only'] })
  })

  it('decides once, so a seen notice never re-arms', async () => {
    await launchOnMirror(MIRROR_FOLDER_TRUST)
    await launchOnRealHome()
    expect(ui.codexSharedSettingsNotice).toEqual({ mcpServerNames: [] })
    ui.codexSharedSettingsNotice = null
    appendMirrorConfig(MIRROR_ONLY_MCP_SERVER)

    await launchOnRealHome()

    expect(ui.codexSharedSettingsNotice).toBeNull()
  })

  it('never shows on a fresh install', async () => {
    await launchOnRealHome()

    expect(ui.codexSharedSettingsNotice).toBeNull()
  })

  it('does nothing on macOS or Linux', async () => {
    await launchOnMirror(MIRROR_FOLDER_TRUST)

    await launchOnRealHome('darwin')

    expect(ui).not.toHaveProperty('codexSharedSettingsNotice')
  })

  it('decides from the usage poll too', async () => {
    await launchOnMirror(MIRROR_FOLDER_TRUST)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const service = await createService(createSettings({ realHomeRoutable: true }))

    expect(service.prepareForRateLimitFetch()).toMatchObject({ kind: 'ready' })

    expect(ui.codexSharedSettingsNotice).toEqual({ mcpServerNames: [] })
  })
})
