import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { readOpenCodeGoKey } from './opencode-go-key'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-opencode-go-key-reader-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Placeholder values only — a real key must never reach a fixture.
function writeCredentialDb(
  name: string,
  rows: { value: string; active: number; created: number }[]
): string {
  const path = join(dir, name)
  const db = new SyncDatabase(path)
  db.exec(
    'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, ' +
      'value TEXT, active INTEGER, time_created INTEGER)'
  )
  rows.forEach((row, index) => {
    db.prepare(
      'INSERT INTO credential (id, integration_id, label, value, active, time_created) ' +
        "VALUES (?, 'opencode-go', 'API key', ?, ?, ?)"
    ).run(`cred_${index}`, row.value, row.active, row.created)
  })
  db.close()
  return path
}

const key = (value: string): string => JSON.stringify({ type: 'key', key: value })

describe('readOpenCodeGoKey', () => {
  it('reports missing for no databases or none holding a key', () => {
    expect(readOpenCodeGoKey([])).toEqual({ status: 'missing' })
    expect(readOpenCodeGoKey([writeCredentialDb('opencode.db', [])])).toEqual({
      status: 'missing'
    })
  })

  it('prefers the active credential, then the newest', () => {
    const path = writeCredentialDb('opencode.db', [
      { value: key('newer-inactive'), active: 0, created: 9 },
      { value: key('active'), active: 1, created: 1 },
      { value: '{not json', active: 1, created: 5 }
    ])
    expect(readOpenCodeGoKey([path])).toEqual({ status: 'found', key: 'active' })
  })

  it('reads past an unreadable database, and reports it when no key is found', () => {
    const corrupt = join(dir, 'opencode-corrupt.db')
    writeFileSync(corrupt, 'not a sqlite database')
    const good = writeCredentialDb('opencode-b.db', [
      { value: key('later'), active: 1, created: 1 }
    ])

    expect(readOpenCodeGoKey([corrupt, good])).toEqual({ status: 'found', key: 'later' })
    expect(readOpenCodeGoKey([corrupt])).toEqual({ status: 'unreadable' })
    expect(readOpenCodeGoKey([join(dir, 'absent.db')])).toEqual({ status: 'unreadable' })
  })
})
