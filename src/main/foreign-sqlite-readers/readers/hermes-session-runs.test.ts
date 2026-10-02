import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { readHermesSessionRunRefRows, readHermesSessionRuns } from './hermes-session-runs'

let dir = ''
let dbPath = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-hermes-reader-'))
  dbPath = join(dir, 'state.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeStateDb(): void {
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL, ended_at REAL,
      end_reason TEXT, model TEXT, message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      estimated_cost_usd REAL)`)
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      tool_name TEXT, reasoning TEXT, reasoning_content TEXT, timestamp REAL)`)
    const session = db.prepare('INSERT INTO sessions (id, title, started_at) VALUES (?, ?, ?)')
    session.run('cron_job-1_a', 'First', 100)
    session.run('cron_job-1_b', 'Second', 200)
    // `_` is a LIKE wildcard: an unescaped pattern for job-1 would also match this one.
    session.run('cron_job-1x_c', 'Other job', 300)
    const message = db.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)'
    )
    message.run('cron_job-1_a', 'assistant', 'later', 2)
    message.run('cron_job-1_a', 'user', 'earlier', 1)
  } finally {
    db.close()
  }
}

describe('readHermesSessionRunRefRows', () => {
  it("lists one job's cron sessions newest first", () => {
    writeStateDb()
    expect(readHermesSessionRunRefRows(dbPath, 'job-1')).toEqual([
      { id: 'cron_job-1_b', started_at: 200 },
      { id: 'cron_job-1_a', started_at: 100 }
    ])
  })

  it('throws for a missing or corrupt database so the client answers its failure value', () => {
    expect(() => readHermesSessionRunRefRows(dbPath, 'job-1')).toThrow()
    writeFileSync(dbPath, 'not a sqlite database'.repeat(100))
    expect(() => readHermesSessionRunRefRows(dbPath, 'job-1')).toThrow()
  })
})

describe('readHermesSessionRuns', () => {
  it('reads every requested run, leaving missing runs out', () => {
    writeStateDb()
    const runs = readHermesSessionRuns(dbPath, [
      'cron_job-1_a',
      'cron_job-1_missing',
      'cron_job-1_b'
    ])
    expect(runs.map((run) => run.id)).toEqual(['cron_job-1_a', 'cron_job-1_b'])
    expect(runs[0]).toMatchObject({
      session: { id: 'cron_job-1_a', title: 'First', started_at: 100 },
      messages: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'later' }
      ]
    })
    expect(runs[1]?.messages).toEqual([])
  })

  it('throws for a missing database', () => {
    expect(() => readHermesSessionRuns(dbPath, ['cron_job-1_a'])).toThrow()
  })
})
