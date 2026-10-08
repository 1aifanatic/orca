import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

const fresh = {
  callerFingerprint: 'user',
  requestId: 'fresh',
  method: 'terminal.send',
  payloadHash: 'payload'
}

function seedExpired(db: OrchestrationDb, count = 1): void {
  db.db
    .prepare(
      `WITH RECURSIVE numbers(value) AS (
       VALUES (1) UNION ALL SELECT value + 1 FROM numbers WHERE value < ?
     )
     INSERT INTO mutation_receipts (
       caller_fingerprint, request_id, method, payload_hash, state, updated_at
     ) SELECT 'other', printf('old_%05d', value), 'terminal.send', 'old',
              'completed', '2000-01-01 00:00:00' FROM numbers`
    )
    .run(count)
}

describe('receipt expiry outside user admission', () => {
  let db: OrchestrationDb | undefined
  let other: Database.Database | undefined
  let directory: string | undefined

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    other?.close()
    other = undefined
    db?.close()
    db = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  it('prunes expired receipts in bounded batches without another user write', () => {
    db = new OrchestrationDb(':memory:')
    seedExpired(db, 300)
    db.beginMutationReceipt(fresh)
    db.completeMutationReceipt({ ...fresh, receipt: '{"accepted":true}' })
    db.beginMutationReceipt({ ...fresh, requestId: 'pending' })
    db.db.exec(
      "UPDATE mutation_receipts SET updated_at = '2000-01-01 00:00:00' WHERE request_id = 'pending'"
    )

    expect(db.getMutationReceipt('other', 'old_00001')).toBeDefined()
    vi.advanceTimersByTime(60_000)
    expect(
      db.db
        .prepare(
          'SELECT COUNT(*) AS count FROM mutation_receipts WHERE state = ? AND caller_fingerprint = ?'
        )
        .get('completed', 'other')
    ).toEqual({ count: 44 })
    expect(db.getMutationReceipt('user', 'pending')).toMatchObject({ state: 'pending' })
    expect(db.beginMutationReceipt(fresh)).toMatchObject({ disposition: 'completed' })
    vi.advanceTimersByTime(60_000)
    expect(db.getMutationReceipt('other', 'old_00300')).toBeUndefined()
    expect(db.getMutationReceipt('user', 'fresh')).toMatchObject({ state: 'completed' })
    expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000)

    db.close()
    db = undefined
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts fresh writes when unrelated deletion fails and retries cleanup later', () => {
    db = new OrchestrationDb(':memory:')
    seedExpired(db)
    db.db.exec(`CREATE TRIGGER refuse_cleanup BEFORE DELETE ON mutation_receipts
      BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(db.beginMutationReceipt(fresh)).toMatchObject({ disposition: 'started' })
    vi.advanceTimersByTime(60_000)
    expect(warn).toHaveBeenCalledWith(
      '[orchestration] expired mutation receipt cleanup failed',
      expect.objectContaining({ message: 'cleanup unavailable' })
    )
    expect(db.getMutationReceipt('other', 'old_00001')).toBeDefined()
    expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(db.beginMutationReceipt({ ...fresh, requestId: 'next' })).toMatchObject({
      disposition: 'started'
    })

    db.db.exec('DROP TRIGGER refuse_cleanup')
    vi.advanceTimersByTime(60_000)
    expect(db.getMutationReceipt('other', 'old_00001')).toBeUndefined()
    expect(db.beginMutationReceipt(fresh)).toMatchObject({ disposition: 'pending' })
  })

  it('yields to another SQLite writer and restores the normal write timeout', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-receipt-maintenance-'))
    const path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
    seedExpired(db)
    other = new Database(path)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    other.exec('BEGIN IMMEDIATE')
    try {
      vi.advanceTimersByTime(60_000)
      expect(warn).toHaveBeenCalledOnce()
      expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000)
    } finally {
      other.exec('ROLLBACK')
    }
    expect(db.beginMutationReceipt(fresh)).toMatchObject({ disposition: 'started' })
    vi.advanceTimersByTime(60_000)
    expect(db.getMutationReceipt('other', 'old_00001')).toBeUndefined()
  })

  it('keeps receipt persistence essential to atomic worker acceptance', () => {
    const store = new OrchestrationDb(':memory:')
    db = store
    const task = store.createTask({ runId: 'run_legacy_local', spec: 'accept one worker' })
    store.db.exec(`CREATE TRIGGER refuse_receipt BEFORE INSERT ON mutation_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
    expect(() =>
      store.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {},
        mutationReceipt: { ...fresh, method: 'orchestration.workerStart' }
      })
    ).toThrow('receipt unavailable')
    expect(store.getTask(task.id)).toMatchObject({ status: 'ready' })
    expect(store.getMutationReceipt('user', 'fresh')).toBeUndefined()
  })
})
