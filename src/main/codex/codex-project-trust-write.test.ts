import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = { fakeHomeDir: '', userDataDir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.userDataDir }
}))

vi.mock('node:os', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

const { markCodexProjectTrusted } = await import('../agent-trust-presets')
const { markCodexProjectTrustedInHome } = await import('./codex-project-trust-write')

let workspace: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-trust-write-home-'))
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-trust-write-user-data-'))
  workspace = mkdtempSync(join(tmpdir(), 'orca-trust-write-ws-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = testState.userDataDir
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of [testState.fakeHomeDir, testState.userDataDir, workspace]) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
})

const runtimeConfigPath = () =>
  join(testState.userDataDir, 'codex-runtime-home', 'home', 'config.toml')
const systemConfigPath = () => join(testState.fakeHomeDir, '.codex', 'config.toml')

describe('Codex workspace trust writes (#23847)', () => {
  it('still trusts the runtime home when ~/.codex cannot be edited, and names why', async () => {
    mkdirSync(join(testState.fakeHomeDir, '.codex'), { recursive: true })
    const brokenUserConfig = '[mcp_servers.a]\ncommand = "x"\n[mcp_servers.a]\ncommand = "y"\n'
    writeFileSync(systemConfigPath(), brokenUserConfig, 'utf-8')

    const failure = markCodexProjectTrusted(workspace)
    await expect(failure).rejects.toThrow('1 of 2 config files')
    await expect(failure).rejects.toThrow(`${systemConfigPath()} unchanged (line 3)`)

    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('trust_level = "trusted"')
    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(brokenUserConfig)
  })

  it('trusts the exact per-account home a launch resolved once its config parses', async () => {
    const accountHome = join(testState.userDataDir, 'codex-accounts', 'a1', 'home')
    mkdirSync(accountHome, { recursive: true })
    writeFileSync(join(accountHome, 'config.toml'), '[a]\n[a]\nx = 1\n[a]\ny = 2\n', 'utf-8')
    await expect(markCodexProjectTrustedInHome(workspace, accountHome)).rejects.toThrow(
      join(accountHome, 'config.toml')
    )

    writeFileSync(join(accountHome, 'config.toml'), 'model = "o3"\n', 'utf-8')
    await markCodexProjectTrustedInHome(workspace, accountHome)

    expect(readFileSync(join(accountHome, 'config.toml'), 'utf-8')).toContain(
      `[projects."${realpathSync.native(workspace).replaceAll('\\', '\\\\')}"]`
    )
  })

  // Why: a read-only directory blocks the temp file only for a non-root POSIX user.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names the config file, not the atomic writer’s temp file, when the home is unwritable',
    async () => {
      const accountHome = join(testState.userDataDir, 'codex-accounts', 'ro', 'home')
      mkdirSync(accountHome, { recursive: true })
      writeFileSync(join(accountHome, 'config.toml'), 'model = "o3"\n', 'utf-8')
      chmodSync(accountHome, 0o555)
      try {
        await expect(markCodexProjectTrustedInHome(workspace, accountHome)).rejects.toThrow(
          `could not write ${join(accountHome, 'config.toml')}:`
        )
      } finally {
        chmodSync(accountHome, 0o755)
      }
    }
  )
})
