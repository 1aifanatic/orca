import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { ManagedDataAccountService } from './service'

let root: string
let source: string
let service: ManagedDataAccountService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-data-accounts-test-'))
  source = join(root, 'source')
  mkdirSync(join(source, 'devin'), { recursive: true })
  writeFileSync(join(source, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-only-key"\n')
  service = new ManagedDataAccountService(join(root, 'managed'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function openCodeSource(sessionTable = 'session'): void {
  mkdirSync(join(source, 'opencode'), { recursive: true })
  const db = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
  db.exec(
    `CREATE TABLE ${sessionTable} (id TEXT); CREATE TABLE credential (integration_id TEXT, value TEXT)`
  )
  db.prepare('INSERT INTO credential VALUES (?, ?)').run(
    'opencode-go',
    JSON.stringify({ type: 'key', key: 'test-only-key' })
  )
  db.close()
}

describe('managed data accounts', () => {
  it('registers private Devin credentials, exposes summaries, and removes only its profile', async () => {
    const state = await service.add('devin', source, 'Work')
    const id = state.accounts[0].id
    expect(JSON.stringify(state)).not.toContain('test-only-key')
    const environment = service.launchEnvironment('devin')
    expect(
      readFileSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml'), 'utf8')
    ).toContain('test-only-key')
    if (process.platform !== 'win32') {
      expect(
        statSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml')).mode & 0o777
      ).toBe(0o600)
    }
    await service.select('devin', null)
    expect(service.launchEnvironment('devin')).toEqual({})
    await service.select('devin', id)
    await service.remove('devin', id)
    expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    expect(existsSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml'))).toBe(false)
    expect(existsSync(join(source, 'devin', 'credentials.toml'))).toBe(true)
  })

  it('captures OpenCode 2 SQLite credentials including WAL without leaking secrets', async () => {
    openCodeSource('session_v2')
    const writer = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
    writer.pragma('journal_mode = WAL')
    writer
      .prepare('INSERT INTO credential VALUES (?, ?)')
      .run('google', JSON.stringify({ type: 'key', key: 'second-test-key' }))
    try {
      const state = await service.add('opencode', source, 'Work')
      expect(state.accounts[0].integrations).toEqual(['opencode-go', 'google'])
      const env = service.launchEnvironment('opencode')
      const captured = new SyncDatabase(join(env.XDG_DATA_HOME, 'opencode', 'opencode.db'), {
        readonly: true
      })
      expect(captured.prepare('SELECT COUNT(*) AS count FROM credential').get()?.count).toBe(2)
      captured.close()
      if (process.platform !== 'win32') {
        expect(statSync(join(env.XDG_DATA_HOME, 'opencode', 'opencode.db')).mode & 0o777).toBe(
          0o600
        )
      }
    } finally {
      writer.close()
    }
  })

  it('rejects importing personal conversation databases and rolls back the directory', async () => {
    openCodeSource()
    const db = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
    db.prepare('INSERT INTO session VALUES (?)').run('personal-session')
    db.close()
    await expect(service.add('opencode', source, 'Work')).rejects.toThrow('conversation databases')
    expect(service.list('opencode').accounts).toEqual([])
    expect(readdirSync(join(root, 'managed', 'opencode'))).toEqual([])
  })

  it('serializes overlapping enrollment so neither account is lost', async () => {
    await Promise.all([service.add('devin', source, 'One'), service.add('devin', source, 'Two')])
    expect(service.list('devin').accounts.map((account) => account.label)).toEqual(['One', 'Two'])
  })

  it('rejects a credential symlink without touching its target', async () => {
    const original = join(source, 'devin', 'credentials.toml')
    const target = join(root, 'private.toml')
    writeFileSync(target, readFileSync(original))
    rmSync(original)
    symlinkSync(target, original)
    await expect(service.add('devin', source, 'Work')).rejects.toThrow('regular file')
    expect(readFileSync(target, 'utf8')).toContain('test-only-key')
  })

  it('keeps credential parse errors out of RPC messages', async () => {
    writeFileSync(
      join(source, 'devin', 'credentials.toml'),
      'windsurf_api_key = "secret-not-for-errors'
    )
    await expect(service.add('devin', source, 'Work')).rejects.toThrow(
      'Unsupported Devin credential format.'
    )
  })
})
