import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createInProcessForeignSqliteReaderWorker } from '../foreign-sqlite-readers/foreign-sqlite-reader-in-process-test-worker'
import { _internals as readerInternals } from '../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import SyncDatabase from '../sqlite/sync-database'
import {
  countCodexSessionFilesUpTo,
  isCodexStateDbBackfillPending,
  readCodexStateDbBackfillSnapshot,
  readCodexStateDbBackfillStatus,
  readIndexedCodexThreadIds
} from './codex-state-db'

const temporaryHomes: string[] = []

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-codex-state-db-'))
  temporaryHomes.push(home)
  return home
}

function createBackfillDb(home: string, version: number, status: string): string {
  const path = join(home, `state_${version}.sqlite`)
  const db = new SyncDatabase(path)
  db.exec(
    'CREATE TABLE backfill_state (id INTEGER PRIMARY KEY, status TEXT NOT NULL); ' +
      `INSERT INTO backfill_state (id, status) VALUES (1, '${status}')`
  )
  db.close()
  return path
}

async function writeRollouts(home: string, count: number, suffix: string): Promise<void> {
  const sessions = join(home, 'sessions', '2026', '08', '04')
  await mkdir(sessions, { recursive: true })
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeFile(join(sessions, `rollout-${index}${suffix}`), '{}\n')
    )
  )
}

beforeAll(() => {
  readerInternals.setWorkerFactory(createInProcessForeignSqliteReaderWorker)
})

afterAll(() => {
  readerInternals.setWorkerFactory(null)
})

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
  )
})

describe('Codex state DB backfill status', () => {
  it('reads the newest schema DB', async () => {
    const home = await createHome()
    createBackfillDb(home, 4, 'complete')
    const newest = createBackfillDb(home, 5, 'running')

    await expect(readCodexStateDbBackfillStatus(home)).resolves.toEqual({
      kind: 'incomplete',
      stateDbPath: newest,
      status: 'running'
    })
  })

  it('treats a large unindexed rollout history as pending', async () => {
    const home = await createHome()
    await writeRollouts(home, 100, '.jsonl')

    await expect(isCodexStateDbBackfillPending(home)).resolves.toBe(true)
    await expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 10)).resolves.toBe(10)
  })

  it('counts compressed rollouts, which Codex also backfills', async () => {
    const home = await createHome()
    await writeRollouts(home, 100, '.jsonl.zst')

    await expect(isCodexStateDbBackfillPending(home)).resolves.toBe(true)
  })

  it('does not call a complete backfill or an unreadable index pending', async () => {
    const complete = await createHome()
    createBackfillDb(complete, 5, 'complete')
    const unreadable = await createHome()
    await writeFile(join(unreadable, 'state_5.sqlite'), 'not a sqlite database')

    await expect(isCodexStateDbBackfillPending(complete)).resolves.toBe(false)
    await expect(isCodexStateDbBackfillPending(unreadable)).resolves.toBe(false)
    await expect(readCodexStateDbBackfillSnapshot(unreadable, 100)).resolves.toMatchObject({
      status: { kind: 'unreadable', stateDbPath: join(unreadable, 'state_5.sqlite') }
    })
  })
})

describe('readIndexedCodexThreadIds', () => {
  it('returns lower-cased thread ids from the newest state DB', async () => {
    const home = await createHome()
    const path = createBackfillDb(home, 5, 'complete')
    const db = new SyncDatabase(path)
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads (id) VALUES ('ABC'), ('def')"
    )
    db.close()

    await expect(readIndexedCodexThreadIds(home)).resolves.toEqual(new Set(['abc', 'def']))
  })

  it('returns null when there is no state DB or no threads table', async () => {
    const home = await createHome()
    await expect(readIndexedCodexThreadIds(home)).resolves.toBeNull()

    createBackfillDb(home, 5, 'complete')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(readIndexedCodexThreadIds(home)).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(
      '[codex-state-db] Failed to read indexed Codex threads:',
      expect.stringContaining('threads')
    )
    warn.mockRestore()
  })
})

describe('when the index reader cannot answer', () => {
  it('returns each existing failure value without reading on the main thread', async () => {
    const home = await createHome()
    // A pending home: a main-thread fallback would read it and answer differently.
    createBackfillDb(home, 5, 'running')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    readerInternals.setWorkerFactory(() => {
      throw new Error('entry not found')
    })
    try {
      await expect(readCodexStateDbBackfillSnapshot(home, 100)).resolves.toBeNull()
      await expect(readCodexStateDbBackfillStatus(home)).resolves.toEqual({
        kind: 'unreadable',
        stateDbPath: null,
        error: 'The Codex index reader did not answer'
      })
      await expect(isCodexStateDbBackfillPending(home)).resolves.toBe(false)
      await expect(readIndexedCodexThreadIds(home)).resolves.toBeNull()
      await expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 1)).resolves.toBe(0)
    } finally {
      readerInternals.setWorkerFactory(createInProcessForeignSqliteReaderWorker)
      vi.restoreAllMocks()
    }
  })
})
