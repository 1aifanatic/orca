import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { readOpenCodeBinderSessions } from './opencode-binder-sessions'

const DIR = '/tmp/binder-worktree-a'
const START = { ms: 0, id: '' }

let dir = ''
let dbPath = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-opencode-binder-reader-'))
  dbPath = join(dir, 'opencode.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeSessions(
  table: 'session' | 'session_v2',
  rows: { id: string; createdAtMs: number; parentId?: string }[]
): void {
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, parent_id TEXT)`
    )
    const insert = db.prepare(
      `INSERT INTO ${table} (id, directory, time_created, parent_id) VALUES (?, ?, ?, ?)`
    )
    for (const row of rows) {
      insert.run(row.id, DIR, row.createdAtMs, row.parentId ?? null)
    }
  } finally {
    db.close()
  }
}

describe('readOpenCodeBinderSessions', () => {
  it('reads OpenCode 1 rows past the cursor, oldest first', () => {
    writeSessions('session', [
      { id: 'ses_b', createdAtMs: 200, parentId: 'ses_a' },
      { id: 'ses_a', createdAtMs: 100 }
    ])
    expect(readOpenCodeBinderSessions(dbPath, START)).toEqual([
      { id: 'ses_a', directory: DIR, createdAtMs: 100, parentId: null },
      { id: 'ses_b', directory: DIR, createdAtMs: 200, parentId: 'ses_a' }
    ])
    expect(readOpenCodeBinderSessions(dbPath, { ms: 200, id: 'ses_b' })).toEqual([])
  })

  it('re-lists rows that share the cursor millisecond with a later id', () => {
    writeSessions('session', [
      { id: 'ses_a', createdAtMs: 100 },
      { id: 'ses_b', createdAtMs: 100 }
    ])
    expect(
      readOpenCodeBinderSessions(dbPath, { ms: 100, id: 'ses_a' }).map((row) => row.id)
    ).toEqual(['ses_b'])
  })

  it('skips OpenCode 2 rows in a database both versions wrote', () => {
    writeSessions('session', [{ id: 'ses_v1', createdAtMs: 100 }])
    writeSessions('session_v2', [{ id: 'ses_v2', createdAtMs: 100 }])
    expect(readOpenCodeBinderSessions(dbPath, START).map((row) => row.id)).toEqual(['ses_v1'])
  })

  it('reads a store without the session table as empty', () => {
    writeSessions('session_v2', [{ id: 'ses_v2', createdAtMs: 100 }])
    expect(readOpenCodeBinderSessions(dbPath, START)).toEqual([])
  })

  it('throws for a missing or corrupt database so the client answers its failure value', () => {
    expect(() => readOpenCodeBinderSessions(join(dir, 'absent.db'), START)).toThrow()
    writeFileSync(dbPath, 'not a sqlite database'.repeat(100))
    expect(() => readOpenCodeBinderSessions(dbPath, START)).toThrow()
  })
})
