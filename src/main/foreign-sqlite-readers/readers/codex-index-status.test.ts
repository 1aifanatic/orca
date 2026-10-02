import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import {
  countCodexSessionFilesUpTo,
  findNewestCodexStateDbPath,
  readCodexIndexStatus
} from './codex-index-status'

const temporaryHomes: string[] = []

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-codex-index-status-'))
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

async function writeRollouts(home: string, count: number, suffix = '.jsonl'): Promise<void> {
  const sessions = join(home, 'sessions', '2026', '08', '04')
  await mkdir(sessions, { recursive: true })
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeFile(join(sessions, `rollout-${index}${suffix}`), '{}\n')
    )
  )
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
  )
})

describe('readCodexIndexStatus backfill', () => {
  it('reads the newest schema DB without mutating an incomplete row', async () => {
    const home = await createHome()
    createBackfillDb(home, 4, 'complete')
    const newest = createBackfillDb(home, 5, 'running')

    expect(findNewestCodexStateDbPath(home)).toBe(newest)
    expect(
      readCodexIndexStatus({ type: 'backfill', codexHomePath: home, sessionFileLimit: 100 })
    ).toEqual({
      type: 'backfill',
      status: { kind: 'incomplete', stateDbPath: newest, status: 'running' },
      sessionFileCount: null
    })
    const db = new SyncDatabase(newest, { readonly: true, fileMustExist: true })
    expect(db.prepare('SELECT status FROM backfill_state WHERE id = 1').get()).toEqual({
      status: 'running'
    })
    db.close()
  })

  it('counts rollouts, compressed ones too, only for a home with no backfill row', async () => {
    const home = await createHome()
    await writeRollouts(home, 3, '.jsonl')
    await writeRollouts(home, 0)
    const sessions = join(home, 'sessions', '2026', '08', '05')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, 'rollout-z.jsonl.zst'), '')

    expect(
      readCodexIndexStatus({ type: 'backfill', codexHomePath: home, sessionFileLimit: 100 })
    ).toEqual({ type: 'backfill', status: { kind: 'missing' }, sessionFileCount: 4 })

    createBackfillDb(home, 5, 'complete')
    expect(
      readCodexIndexStatus({ type: 'backfill', codexHomePath: home, sessionFileLimit: 100 })
    ).toMatchObject({ status: { kind: 'complete' }, sessionFileCount: null })
  })

  it('stops counting at the limit', async () => {
    const home = await createHome()
    await writeRollouts(home, 5)
    expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 2)).toBe(2)
    expect(
      readCodexIndexStatus({
        type: 'sessionFileCount',
        sessionsRoot: join(home, 'sessions'),
        limit: 100
      })
    ).toEqual({ type: 'sessionFileCount', count: 5 })
  })

  it('reports a corrupt state DB as unreadable with its path', async () => {
    const home = await createHome()
    await writeFile(join(home, 'state_5.sqlite'), 'not a sqlite database')

    expect(
      readCodexIndexStatus({ type: 'backfill', codexHomePath: home, sessionFileLimit: 100 })
    ).toMatchObject({
      status: { kind: 'unreadable', stateDbPath: join(home, 'state_5.sqlite') },
      sessionFileCount: null
    })
  })

  it('reports a DB without a backfill table as not tracked', async () => {
    const home = await createHome()
    const db = new SyncDatabase(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)')
    db.close()

    expect(
      readCodexIndexStatus({ type: 'backfill', codexHomePath: home, sessionFileLimit: 100 })
    ).toMatchObject({ status: { kind: 'not-tracked' }, sessionFileCount: 0 })
  })
})

describe('readCodexIndexStatus indexedThreadIds', () => {
  it('returns lower-cased thread ids from the newest state DB', async () => {
    const home = await createHome()
    const db = new SyncDatabase(createBackfillDb(home, 5, 'complete'))
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads (id) VALUES ('ABC'), ('def')"
    )
    db.close()

    expect(readCodexIndexStatus({ type: 'indexedThreadIds', codexHomePath: home })).toEqual({
      type: 'indexedThreadIds',
      threadIds: ['abc', 'def'],
      error: null
    })
  })

  it('returns null ids for no state DB, and an error for no threads table', async () => {
    const home = await createHome()
    expect(readCodexIndexStatus({ type: 'indexedThreadIds', codexHomePath: home })).toEqual({
      type: 'indexedThreadIds',
      threadIds: null,
      error: null
    })

    createBackfillDb(home, 5, 'complete')
    expect(readCodexIndexStatus({ type: 'indexedThreadIds', codexHomePath: home })).toMatchObject({
      threadIds: null,
      error: expect.stringContaining('threads')
    })
  })
})
