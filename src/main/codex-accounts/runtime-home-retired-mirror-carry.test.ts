import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
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
import { LEGACY_SHARED_MCP_CREDENTIALS_MIGRATION_MARKER } from './legacy-shared-auth-migration'
import { RETIRED_MIRROR_CARRY_MARKER } from './retired-mirror-carry'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type * as CodexAccountFs from './fs-utils'

vi.mock('../codex/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

const concurrentEdit = vi.hoisted(() => {
  const edit: { path: string | null } = { path: null }
  return edit
})

// Why: lands a write on ~/.codex between the carry's read and its guarded write.
vi.mock('./fs-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexAccountFs>()
  return {
    ...actual,
    writeFileAtomicallyIfUnchanged: (
      ...args: Parameters<typeof actual.writeFileAtomicallyIfUnchanged>
    ) => {
      if (args[0] === concurrentEdit.path) {
        writeFileSync(args[0], 'model = "concurrent"\n')
        concurrentEdit.path = null
      }
      return actual.writeFileAtomicallyIfUnchanged(...args)
    }
  }
})

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
    concurrentEdit.path = null
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

  it.each(['migrated', 'per-account-present'])(
    "keeps MCP credentials a managed account's migration claimed (%s) out of ~/.codex",
    async (outcome) => {
      await launchOnMirror()
      writeFileSync(join(getRuntimeCodexHomePath(), '.credentials.json'), 'managed-mcp', 'utf-8')
      writeFileSync(
        join(
          testState.userDataDir,
          'codex-runtime-home',
          LEGACY_SHARED_MCP_CREDENTIALS_MIGRATION_MARKER
        ),
        JSON.stringify({ completedAt: 1, outcome, accountId: 'account-1' })
      )

      await upgradeToRealHome()

      expect(existsSync(join(getSystemCodexHomePath(), '.credentials.json'))).toBe(false)
      expect(existsSync(getMarkerPath())).toBe(true)
    }
  )

  it("carries nothing when the mirror's login belongs to another account", async () => {
    const seeded = createCodexAuthJson('me@example.com', 'acct-me', 'seeded')
    writeFileSync(getSystemCodexAuthPath(), seeded, 'utf-8')
    await launchOnMirror()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('other@example.com', 'acct-other', 'other'),
      'utf-8'
    )

    await upgradeToRealHome()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(seeded)
  })

  it('carries no credentials while a managed account owns the mirror', async () => {
    await launchOnMirror()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed'),
      'utf-8'
    )
    writeFileSync(join(getRuntimeCodexHomePath(), '.credentials.json'), 'managed-mcp', 'utf-8')
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({ owner: 'managed', accountId: 'account-1' })}\n`
    )

    await upgradeToRealHome()

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
    expect(existsSync(join(getSystemCodexHomePath(), '.credentials.json'))).toBe(false)
  })

  it('leaves an existing ~/.codex credential store exactly as it is', async () => {
    await launchOnMirror()
    const systemCredentials = join(getSystemCodexHomePath(), '.credentials.json')
    writeFileSync(systemCredentials, 'not even json', 'utf-8')
    writeFileSync(
      join(getRuntimeCodexHomePath(), '.credentials.json'),
      JSON.stringify({ paneOnly: 'mirror' }),
      'utf-8'
    )

    await upgradeToRealHome()

    expect(readFileSync(systemCredentials, 'utf-8')).toBe('not even json')
    expect(existsSync(getMarkerPath())).toBe(true)
  })

  it('keeps MCP credentials out of a ~/.codex logged into another account', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'seeded'),
      'utf-8'
    )
    await launchOnMirror()
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('other@example.com', 'acct-other', 'other'),
      'utf-8'
    )
    writeFileSync(join(getRuntimeCodexHomePath(), '.credentials.json'), 'my-mcp', 'utf-8')

    await upgradeToRealHome()

    expect(existsSync(join(getSystemCodexHomePath(), '.credentials.json'))).toBe(false)
  })

  it('carries MCP credentials into a ~/.codex still on the same account', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'seeded'),
      'utf-8'
    )
    await launchOnMirror()
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'refreshed-outside'),
      'utf-8'
    )
    writeFileSync(join(getRuntimeCodexHomePath(), '.credentials.json'), 'my-mcp', 'utf-8')

    await upgradeToRealHome()

    expect(readFileSync(join(getSystemCodexHomePath(), '.credentials.json'), 'utf-8')).toBe(
      'my-mcp'
    )
  })

  it("leaves a retained pane's mirror config alone until the carry lands", async () => {
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'model = "gpt-5"\n', 'utf-8')
    await launchOnMirror()
    const mirrorConfigPath = join(getRuntimeCodexHomePath(), 'config.toml')
    writeFileSync(
      mirrorConfigPath,
      `${readFileSync(mirrorConfigPath, 'utf-8')}\n[mcp_servers.pane]\ncommand = "pane-mcp"\n`,
      'utf-8'
    )
    concurrentEdit.path = join(getSystemCodexHomePath(), 'config.toml')

    await upgradeToRealHome()

    expect(readFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'utf-8')).toBe(
      'model = "concurrent"\n'
    )
    expect(readFileSync(mirrorConfigPath, 'utf-8')).toContain('[mcp_servers.pane]')

    await upgradeToRealHome()
    expect(readFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'utf-8')).toContain(
      '[mcp_servers.pane]'
    )
  })

  it("carries MCP credentials when ~/.codex later logged into the pane's account", async () => {
    await launchOnMirror()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'pane'),
      'utf-8'
    )
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'outside'),
      'utf-8'
    )
    writeFileSync(join(getRuntimeCodexHomePath(), '.credentials.json'), 'my-mcp', 'utf-8')

    await upgradeToRealHome()

    expect(readFileSync(join(getSystemCodexHomePath(), '.credentials.json'), 'utf-8')).toBe(
      'my-mcp'
    )
  })

  it('keeps MCP credentials of a pane that re-logged into another account', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'seeded'),
      'utf-8'
    )
    await launchOnMirror()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('other@example.com', 'acct-other', 'pane'),
      'utf-8'
    )
    writeFileSync(join(getRuntimeCodexHomePath(), '.credentials.json'), 'other-mcp', 'utf-8')

    await upgradeToRealHome()

    expect(existsSync(join(getSystemCodexHomePath(), '.credentials.json'))).toBe(false)
  })

  it('carries the mirror before a usage poll reads ~/.codex', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'seeded'),
      'utf-8'
    )
    await launchOnMirror()
    const refreshed = createCodexAuthJson('me@example.com', 'acct-me', 'refreshed')
    writeFileSync(getRuntimeCodexAuthPath(), refreshed, 'utf-8')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const service = await createService(createSettings({ realHomeRoutable: true }))

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshed)
  })

  it("keeps a retained pane's login in step while the carry is still incomplete", async () => {
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'model = "gpt-5"\n', 'utf-8')
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'seeded'),
      'utf-8'
    )
    await launchOnMirror()
    const mirrorConfigPath = join(getRuntimeCodexHomePath(), 'config.toml')
    writeFileSync(
      mirrorConfigPath,
      `${readFileSync(mirrorConfigPath, 'utf-8')}\n[mcp_servers.pane]\ncommand = "pane-mcp"\n`,
      'utf-8'
    )
    const refreshedOutside = createCodexAuthJson('me@example.com', 'acct-me', 'outside')
    writeFileSync(getSystemCodexAuthPath(), refreshedOutside, 'utf-8')
    concurrentEdit.path = join(getSystemCodexHomePath(), 'config.toml')

    await upgradeToRealHome()

    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8')).completed).not.toContain('tables')
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedOutside)
  })

  it.each([
    ['a custom CODEX_HOME', (): Partial<GlobalSettings> => ({})],
    [
      'a managed account selection',
      (): Partial<GlobalSettings> & { realHomeRoutable: boolean } => ({
        realHomeRoutable: true,
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} },
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'managed@example.com',
            managedHomePath: createManagedAuth(
              testState.userDataDir,
              'account-1',
              createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
            ),
            providerAccountId: 'acct-managed',
            workspaceLabel: null,
            workspaceAccountId: 'acct-managed',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ]
      })
    ]
  ])('never carries on Windows for %s', async (_label, overrides) => {
    await launchOnMirror()
    writeFileSync(
      getRuntimeCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'pane'),
      'utf-8'
    )
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const service = await createService(createSettings(overrides()))

    service.reconcileLegacySharedHomeForRetainedPanes()

    expect(existsSync(getMarkerPath())).toBe(false)
    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
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
