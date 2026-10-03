import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
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
import * as secureFile from '../../shared/secure-file'
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
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

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
  it.each(['before write', 'after write', 'unrestricted'])(
    'preserves credentials and original metadata when removal persistence fails %s',
    async (failure) => {
      const before = await service.add('devin', source, 'Work')
      const environment = service.launchEnvironment('devin')
      const credentialsPath = join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml')
      const credentials = readFileSync(credentialsPath)
      const metadataPath = join(root, 'managed', 'devin', 'accounts.json')
      const metadata = readFileSync(metadataPath)
      const changed = vi.fn()
      service.onChanged(changed)
      const write = secureFile.writeSecureFile
      const failingWrite = vi.spyOn(secureFile, 'writeSecureFile').mockImplementation((...args) => {
        if (args[0] !== metadataPath) {
          return write(...args)
        }
        if (failure === 'before write') {
          throw new Error('metadata write failed')
        }
        write(...args)
        if (failure === 'unrestricted') {
          return false
        }
        throw new Error('metadata write failed')
      })

      await expect(service.remove('devin', before.accounts[0].id)).rejects.toThrow(
        failure === 'unrestricted' ? 'metadata permissions' : 'metadata write failed'
      )
      expect(readFileSync(credentialsPath)).toEqual(credentials)
      expect(readFileSync(metadataPath)).toEqual(metadata)
      expect(service.list('devin')).toEqual(before)
      expect(service.launchEnvironment('devin')).toEqual(environment)
      expect(changed).not.toHaveBeenCalled()
      expect(readdirSync(join(root, 'managed', 'devin')).sort()).toEqual(
        [before.accounts[0].id, 'accounts.json'].sort()
      )

      failingWrite.mockRestore()
      await service.remove('devin', before.accounts[0].id)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    }
  )

  it('retains selected account metadata after locked cleanup and permits retry', async () => {
    let locked = true
    service = new ManagedDataAccountService(join(root, 'managed'), (directory) => {
      if (locked) {
        throw new Error('file locked')
      }
      rmSync(directory, { recursive: true, force: true })
    })
    const before = await service.add('devin', source, 'Work')
    const environment = service.launchEnvironment('devin')
    const metadataPath = join(root, 'managed', 'devin', 'accounts.json')
    const metadata = readFileSync(metadataPath)
    const changed = vi.fn()
    service.onChanged(changed)
    await expect(service.remove('devin', before.accounts[0].id)).rejects.toThrow('file locked')
    expect(service.list('devin')).toEqual(before)
    expect(readFileSync(metadataPath)).toEqual(metadata)
    expect(service.launchEnvironment('devin')).toEqual(environment)
    expect(
      readFileSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml'), 'utf8')
    ).toContain('test-only-key')
    expect(changed).not.toHaveBeenCalled()
    locked = false
    await service.remove('devin', before.accounts[0].id)
    expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    expect(changed).toHaveBeenCalledTimes(1)
  })

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

  it.each([
    'message',
    'part',
    'todo',
    'session_message',
    'session_pending',
    'session_inbox',
    'session_input',
    'session_context_epoch',
    'instruction_blob',
    'instruction_entry',
    'instruction_state',
    'event'
  ])('rejects synthetic orphan %s rows even with empty session containers', async (table) => {
    openCodeSource('session_v2')
    const databasePath = join(source, 'opencode', 'opencode.db')
    const db = new SyncDatabase(databasePath)
    // Synthetic orphans exercise damaged/FK-off files, not normal CLI writes.
    db.exec(`CREATE TABLE ${table} (data TEXT)`)
    db.prepare(`INSERT INTO ${table} VALUES (?)`).run('private-conversation-content')
    db.close()
    const original = readFileSync(databasePath)

    await expect(service.add('opencode', source, 'Work')).rejects.toThrow('conversation databases')
    expect(service.list('opencode')).toEqual({ accounts: [], activeAccountId: null })
    expect(readdirSync(join(root, 'managed', 'opencode'))).toEqual([])
    expect(readFileSync(databasePath)).toEqual(original)
  })

  it('serializes overlapping enrollment so neither account is lost', async () => {
    await Promise.all([service.add('devin', source, 'One'), service.add('devin', source, 'Two')])
    expect(service.list('devin').accounts.map((account) => account.label)).toEqual(['One', 'Two'])
  })

  it('keeps registered transcript roots available when selection changes', async () => {
    const first = await service.add('devin', source, 'One')
    const firstEnvironment = service.launchEnvironment('devin')
    await service.add('devin', source, 'Two')
    const secondEnvironment = service.launchEnvironment('devin')
    expect(service.transcriptEnvironments('devin')).toEqual([secondEnvironment, firstEnvironment])
    await service.select('devin', first.accounts[0].id)
    expect(service.transcriptEnvironments('devin')).toEqual([firstEnvironment, secondEnvironment])
    await service.select('devin', null)
    expect(service.transcriptEnvironments('devin')).toEqual([firstEnvironment, secondEnvironment])
    await service.remove('devin', first.accounts[0].id)
    expect(service.transcriptEnvironments('devin')).toEqual([secondEnvironment])
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
