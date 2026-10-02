import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { captureManagedDataAccountOriginalEnvironment } from '../../shared/managed-data-account-environment'
import {
  getOpenCodeAuthFilePath,
  readOpenCodeAuthFileGoKey,
  resolveOpenCodeGoApiKey
} from './opencode-go-api-key-source'

const selectedAccount = vi.hoisted(() => {
  const environment: NodeJS.ProcessEnv = {}
  return { environment, launchEnvironment: vi.fn(() => environment) }
})
vi.mock('../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({ launchEnvironment: selectedAccount.launchEnvironment })
}))

// Placeholder values only — a real key must never reach a fixture.
const SETTINGS_KEY = 'settings-placeholder-key'
const ENVIRONMENT_KEY = 'environment-placeholder-key'
const AUTH_FILE_KEY = 'auth-file-placeholder-key'
const DATABASE_KEY = 'database-placeholder-key'

const ENVIRONMENT_KEYS = [
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_API_KEY',
  'OPENCODE_DB',
  'OPENCODE_AUTH_CONTENT',
  'ORCA_DATA_ACCOUNT_ORIGINAL_ENV',
  'ORCA_DATA_ACCOUNT_DATA_HOME',
  'ORCA_DATA_ACCOUNT_STATE_HOME',
  'ORCA_DATA_ACCOUNT_PROVIDER'
] as const

describe('resolveOpenCodeGoApiKey', () => {
  let dataHome: string
  let originalEnvironment: Partial<Record<(typeof ENVIRONMENT_KEYS)[number], string>>

  function writeAuthFile(contents: unknown): void {
    mkdirSync(join(dataHome, 'opencode'), { recursive: true })
    writeFileSync(join(dataHome, 'opencode', 'auth.json'), JSON.stringify(contents))
  }

  function writeCredentialDatabase(
    rows: { value: string; active: number; created: number }[],
    directory = dataHome,
    filename = 'opencode-credentials.db'
  ): {
    path: string
  } {
    const path = join(directory, filename)
    const database = new Database(path)
    database.exec(
      'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, ' +
        'value TEXT, active INTEGER, time_created INTEGER)'
    )
    rows.forEach((row, index) => {
      database
        .prepare(
          'INSERT INTO credential (id, integration_id, label, value, active, time_created) ' +
            "VALUES (?, 'opencode-go', 'API key', ?, ?, ?)"
        )
        .run(`cred_${index}`, row.value, row.active, row.created)
    })
    database.close()
    return { path }
  }

  beforeEach(() => {
    selectedAccount.launchEnvironment.mockReset()
    selectedAccount.launchEnvironment.mockImplementation(() => selectedAccount.environment)
    originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
    for (const key of ENVIRONMENT_KEYS) {
      delete process.env[key]
    }
    dataHome = mkdtempSync(join(tmpdir(), 'orca-opencode-go-key-'))
    for (const key of Object.keys(selectedAccount.environment)) {
      delete selectedAccount.environment[key]
    }
    process.env.XDG_DATA_HOME = dataHome
    delete process.env.OPENCODE_API_KEY
    // Keeps the credential-database tier from touching the developer's own store.
    process.env.OPENCODE_DB = ':memory:'
  })

  it('restores the System key around selected-account usage in a nested managed host', async () => {
    const system = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: 'system-placeholder' }), active: 1, created: 1 }
    ])
    const nestedData = join(dataHome, 'nested')
    const nestedDirectory = join(nestedData, 'opencode')
    mkdirSync(nestedDirectory, { recursive: true })
    writeCredentialDatabase(
      [
        { value: JSON.stringify({ type: 'key', key: 'nested-placeholder' }), active: 1, created: 1 }
      ],
      nestedDirectory,
      'opencode.db'
    )
    const selectedDirectory = join(dataHome, 'selected')
    mkdirSync(selectedDirectory)
    const selected = writeCredentialDatabase(
      [
        {
          value: JSON.stringify({ type: 'key', key: 'selected-placeholder' }),
          active: 1,
          created: 1
        }
      ],
      selectedDirectory
    )
    const inherited: Record<string, string> = {
      XDG_DATA_HOME: dataHome,
      OPENCODE_DB: system.path,
      OPENCODE_AUTH_CONTENT: 'system-placeholder-content'
    }
    captureManagedDataAccountOriginalEnvironment(inherited)
    Object.assign(inherited, {
      XDG_DATA_HOME: nestedData,
      XDG_STATE_HOME: join(nestedData, 'state'),
      OPENCODE_DB: 'opencode.db',
      OPENCODE_AUTH_CONTENT: '',
      ORCA_DATA_ACCOUNT_DATA_HOME: nestedData,
      ORCA_DATA_ACCOUNT_STATE_HOME: join(nestedData, 'state'),
      ORCA_DATA_ACCOUNT_PROVIDER: 'opencode'
    })
    Object.assign(process.env, inherited)
    const hostBefore = { ...process.env }
    const systemResult = {
      status: 'found',
      tier: 'opencode-credential-database',
      key: 'system-placeholder'
    }
    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual(systemResult)
    selectedAccount.environment.XDG_DATA_HOME = selectedDirectory
    selectedAccount.environment.OPENCODE_DB = selected.path
    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      ...systemResult,
      key: 'selected-placeholder'
    })
    for (const key of Object.keys(selectedAccount.environment)) {
      delete selectedAccount.environment[key]
    }
    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual(systemResult)
    expect(process.env).toEqual(hostBefore)
  })

  afterEach(() => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = originalEnvironment[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(dataHome, { recursive: true, force: true })
  })

  it('reads only the selected account database rather than the host default key', async () => {
    const directory = join(dataHome, 'selected')
    mkdirSync(directory)
    const host = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: 'host-key' }), active: 1, created: 1 }
    ])
    const selected = writeCredentialDatabase(
      [{ value: JSON.stringify({ type: 'key', key: 'selected-key' }), active: 1, created: 1 }],
      directory
    )
    process.env.OPENCODE_DB = host.path
    selectedAccount.environment.XDG_DATA_HOME = directory
    selectedAccount.environment.OPENCODE_DB = selected.path
    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      tier: 'opencode-credential-database',
      key: 'selected-key'
    })
  })

  it('keeps legacy auth-file fallback inside the selected account home', async () => {
    writeAuthFile({ 'opencode-go': { type: 'api', key: 'host-key' } })
    const directory = join(dataHome, 'selected')
    mkdirSync(join(directory, 'opencode'), { recursive: true })
    writeFileSync(
      join(directory, 'opencode', 'auth.json'),
      JSON.stringify({
        'opencode-go': { type: 'api', key: 'selected-key' }
      })
    )
    selectedAccount.environment.XDG_DATA_HOME = directory
    selectedAccount.environment.OPENCODE_DB = ':memory:'
    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      tier: 'opencode-auth-file',
      key: 'selected-key'
    })
  })

  it('reads auth.json from XDG_DATA_HOME, which OpenCode uses on every platform', () => {
    expect(getOpenCodeAuthFilePath({ XDG_DATA_HOME: '/data' })).toBe('/data/opencode/auth.json')
    // OpenCode's global-roots.ts falls back to os.homedir() + .local/share even on Windows.
    expect(getOpenCodeAuthFilePath({}, '/home/person')).toBe(
      join('/home/person', '.local', 'share', 'opencode', 'auth.json')
    )
  })

  it('uses an explicit settings override before malformed account metadata', async () => {
    selectedAccount.launchEnvironment.mockImplementation(() => {
      JSON.parse('{malformed account metadata')
      return selectedAccount.environment
    })
    await expect(resolveOpenCodeGoApiKey({ settingsOverride: SETTINGS_KEY })).resolves.toEqual({
      status: 'found',
      key: SETTINGS_KEY,
      tier: 'settings'
    })
    expect(selectedAccount.launchEnvironment).not.toHaveBeenCalled()
  })

  it('refuses unknown account identity without falling back to the host key', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    selectedAccount.launchEnvironment.mockImplementation(() => {
      throw new Error('Selected account identity is unavailable')
    })
    await expect(resolveOpenCodeGoApiKey({ settingsOverride: ' ' })).rejects.toThrow(
      'Selected account identity is unavailable'
    )
  })

  it('prefers the settings override over every other tier', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })

    await expect(
      resolveOpenCodeGoApiKey({ settingsOverride: `  ${SETTINGS_KEY}  ` })
    ).resolves.toEqual({ status: 'found', key: SETTINGS_KEY, tier: 'settings' })
  })

  it('prefers the key OpenCode saved on /connect over OPENCODE_API_KEY, as OpenCode does', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })

    await expect(resolveOpenCodeGoApiKey({ settingsOverride: '   ' })).resolves.toEqual({
      status: 'found',
      key: AUTH_FILE_KEY,
      tier: 'opencode-auth-file'
    })
  })

  it('falls back to OPENCODE_API_KEY when OpenCode stored no key', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ anthropic: { type: 'api', key: 'not-the-go-key' } })

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: ENVIRONMENT_KEY,
      tier: 'environment'
    })
  })

  it('falls back to the key OpenCode 1.x saved on /connect', async () => {
    writeAuthFile({
      anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
      'opencode-go': { type: 'api', key: AUTH_FILE_KEY }
    })

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: AUTH_FILE_KEY,
      tier: 'opencode-auth-file'
    })
  })

  it('falls back to the OpenCode 2 credential table when auth.json has no entry', async () => {
    writeAuthFile({ anthropic: { type: 'api', key: 'not-the-go-key' } })
    const { path } = writeCredentialDatabase([
      {
        value: JSON.stringify({ type: 'key', key: 'stale-placeholder-key' }),
        active: 0,
        created: 2
      },
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: DATABASE_KEY,
      tier: 'opencode-credential-database'
    })
  })

  it('prefers the credential table over a stale auth.json, since OpenCode 2 stops writing the file', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    const { path } = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: DATABASE_KEY,
      tier: 'opencode-credential-database'
    })
  })

  it('keeps the settings override above the credential table', async () => {
    const { path } = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({ settingsOverride: SETTINGS_KEY })).resolves.toEqual({
      status: 'found',
      key: SETTINGS_KEY,
      tier: 'settings'
    })
  })

  it('reports missing when no tier holds a key', async () => {
    writeAuthFile({ 'opencode-go': { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } })

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({ status: 'missing' })
  })

  it('treats a malformed auth file as "no key" rather than a failure', () => {
    mkdirSync(join(dataHome, 'opencode'), { recursive: true })
    writeFileSync(join(dataHome, 'opencode', 'auth.json'), '{not json')

    expect(readOpenCodeAuthFileGoKey(process.env)).toBeNull()
  })
})
