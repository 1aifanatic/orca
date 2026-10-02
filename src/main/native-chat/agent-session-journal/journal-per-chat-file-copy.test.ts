// A per-chat file's copy publishes the chat's status row from the copy's own fold, hands back the
// load a replay would read, stops within one batch once quit aborts imports, deletes what a stopped
// try staged a batch at a time, and deletes the file only while it is still as it stood before the
// verify read it.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { replayJournal } from './journal-open'
import { JournalImportAbortedError } from './journal-open-failure'
import { legacyJournalDatabaseFile } from './journal-paths'
import {
  writePerChatJournalFile,
  type PerChatJournalRepair
} from './journal-per-chat-file-test-support'
import { importPerSessionJournal } from './journal-per-session-import'
import { charBoundedBatches } from './journal-session-status-backfill'
import { backfillJournalSessionStatus } from './journal-session-status-backfill'
import {
  deriveJournalSessionStatus,
  isUnsettledJournalSessionStatus
} from './journal-session-state'
import {
  CORPUS_UNSETTLED,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS,
  type JournalSessionStateCase
} from './journal-session-state-test-corpus'
import { iterateJournalEpochRows, readJournalSessionEpoch } from './journal-row-table'
import type { JournalStoredRow } from './journal-row-table'
import type { AgentSessionJournal } from './journal-store'

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000

function identity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
  }
}

/** The chat as an earlier build left it: written by today's store elsewhere, then moved into its
 *  per-chat file. */
async function stageChat(
  sessionId: string,
  write: (journal: AgentSessionJournal) => Promise<void>,
  repair?: (tip: number, epoch: string) => PerChatJournalRepair
): Promise<{ directory: string; epoch: string; rows: JournalStoredRow[] }> {
  const scratch = join(root, `scratch-${sessionId}`)
  const journal = await journals.open({
    identity: identity(sessionId),
    stateDirectory: scratch,
    now: () => (clock += 1)
  })
  await write(journal)
  const { db } = openTestJournalHostDatabase(scratch)
  const epoch = readJournalSessionEpoch(db, sessionId)!
  const rows = [...iterateJournalEpochRows(db, sessionId, epoch)]
  const directory = openTestJournalHostDatabase(root).legacyDirectoryFor(identity(sessionId))
  writePerChatJournalFile(directory, sessionId, {
    epoch,
    rows,
    repair: repair?.(rows.at(-1)!.seq, epoch) ?? null
  })
  return { directory, epoch, rows }
}

async function manyItems(journal: AgentSessionJournal, count = 8): Promise<void> {
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `reply ${ordinal}` }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
}

/** Runs `after` once, right after the first synced transaction (the publish) commits: copy batches
 *  commit unsynced. Throws instead of committing when `fail` is set. */
function onPublish(database: JournalHostDatabase, hook: { after?: () => void; fail?: Error }) {
  let fired = false
  // Bound before the spy replaces it: the real commit.
  const commit = database.transaction.bind(database)
  return vi.spyOn(database, 'transaction').mockImplementation((run) => {
    const synced = database.db.pragma('synchronous', { simple: true }) !== 1
    if (synced && !fired && hook.fail) {
      fired = true
      throw hook.fail
    }
    const out = commit(run)
    if (synced && !fired) {
      fired = true
      hook.after?.()
    }
    return out
  })
}

function importChat(
  sessionId: string,
  directory: string,
  deps: Partial<Parameters<typeof importPerSessionJournal>[0]> = {}
) {
  return importPerSessionJournal({
    database: openTestJournalHostDatabase(root),
    identity: identity(sessionId),
    legacyDirectory: directory,
    ...deps
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-per-chat-copy-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the status a copy publishes (T3, T3b, T3c)', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)(
    'writes the status a replay derives, in the publish, for a chat that is %s',
    async (name: JournalSessionStateCase) => {
      const sessionId = `session-${JOURNAL_SESSION_STATE_CASES.indexOf(name)}`
      const { directory } = await stageChat(sessionId, JOURNAL_SESSION_STATE_CORPUS[name])

      const result = await importChat(sessionId, directory)

      const db = openTestJournalHostDatabase(root).db
      const replayed = replayJournal(db, sessionId)!
      const stored = readTestJournalSessionStatus(root, sessionId)
      expect(stored).toEqual(
        deriveJournalSessionStatus(replayed.state, { settlesRosters: !replayed.corrupt })
      )
      expect(result.status).toEqual(stored)
      expect(isUnsettledJournalSessionStatus(stored!)).toBe(CORPUS_UNSETTLED[name])
    }
  )

  it('hands back the load a replay of the published chat reads, a repair still owed included', async () => {
    // The repair left sequence `tip + 1` free and nothing has written there: still owed, so corrupt.
    const { directory } = await stageChat('session-repaired', manyItems, (tip, epoch) => ({
      epoch,
      contentFrom: tip + 1,
      repairedAt: 5
    }))

    const result = await importChat('session-repaired', directory)

    const replayed = replayJournal(openTestJournalHostDatabase(root).db, 'session-repaired')
    expect(replayed?.corrupt).toBe(true)
    expect(result.load).toEqual(replayed)
    // A corrupt fold still gets its row, without the rosters its rebuild owns.
    expect(readTestJournalSessionStatus(root, 'session-repaired')).toEqual(
      deriveJournalSessionStatus(replayed!.state, { settlesRosters: false })
    )
  })
})

describe('stopping a copy for quit (T6, T6p, T6b)', () => {
  it('stops between copy batches, publishes nothing, and the next launch copies it once', async () => {
    const { directory, epoch, rows } = await stageChat('session-quit', manyItems)
    const before = await readFile(legacyJournalDatabaseFile(directory))
    const database = openTestJournalHostDatabase(root)
    const commit = database.unsyncedTransaction.bind(database)
    const batch = vi.spyOn(database, 'unsyncedTransaction')
    batch.mockImplementation((run) => {
      const out = commit(run)
      // The delete of what an earlier try staged, then two copy batches.
      if (batch.mock.calls.length === 3) {
        database.abortImports()
      }
      return out
    })

    await expect(importChat('session-quit', directory, { batchRows: 1 })).rejects.toBeInstanceOf(
      JournalImportAbortedError
    )

    expect(batch).toHaveBeenCalledTimes(3)
    expect(readJournalSessionEpoch(database.db, 'session-quit')).toBeNull()
    expect((await readFile(legacyJournalDatabaseFile(directory))).equals(before)).toBe(true)
    // The next launch: its first batch deletes what the stopped one staged.
    batch.mockRestore()
    closeTestJournalHostDatabase(root)
    const result = await importChat('session-quit', directory, { batchRows: 1 })
    const db = openTestJournalHostDatabase(root).db
    expect(result.outcome).toBe('imported')
    expect([...iterateJournalEpochRows(db, 'session-quit', epoch)]).toEqual(rows)
    expect(db.prepare('SELECT count(*) AS n FROM journal_rows').get()).toEqual({ n: rows.length })
  })

  it('deletes what a stopped try staged a batch per task, and stops between those batches too', async () => {
    const { directory, epoch, rows } = await stageChat('session-staged', manyItems)
    const stage = openTestJournalHostDatabase(root).db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (let seq = 1_001; seq <= 1_010; seq += 1) {
      stage.run('session-staged', epoch, seq, 1, '{}')
    }
    const stagedLeft = () =>
      openTestJournalHostDatabase(root)
        .db.prepare('SELECT count(*) AS n FROM journal_rows WHERE session_id = ? AND seq > 1000')
        .get('session-staged')?.n
    /** The staged rows left after each batch transaction; quit lands after the `abortAfter`th. */
    const trackStaged = (abortAfter?: number) => {
      const database = openTestJournalHostDatabase(root)
      const left: unknown[] = []
      const commit = database.unsyncedTransaction.bind(database)
      const batch = vi.spyOn(database, 'unsyncedTransaction').mockImplementation((run) => {
        const out = commit(run)
        left.push(stagedLeft())
        if (batch.mock.calls.length === abortAfter) {
          database.abortImports()
        }
        return out
      })
      return left
    }

    const stopped = trackStaged(1)
    await expect(importChat('session-staged', directory, { batchRows: 4 })).rejects.toBeInstanceOf(
      JournalImportAbortedError
    )
    expect(stopped).toEqual([6])

    // The next launch deletes the rest a batch at a time, with other work between, then copies.
    closeTestJournalHostDatabase(root)
    const next = trackStaged()
    const turns: unknown[] = []
    let ticking = true
    const tick = (): void => {
      turns.push(stagedLeft())
      if (ticking) {
        setImmediate(tick)
      }
    }
    setImmediate(tick)
    expect((await importChat('session-staged', directory, { batchRows: 4 })).outcome).toBe(
      'imported'
    )
    ticking = false
    expect(next.slice(0, 2)).toEqual([2, 0])
    expect(turns).toContain(2)
    expect([
      ...iterateJournalEpochRows(openTestJournalHostDatabase(root).db, 'session-staged', epoch)
    ]).toEqual(rows)
  })

  it('stops a verify within one batch of the abort, on the file side as on the copy side', async () => {
    const { directory, rows } = await stageChat('session-verify', manyItems)
    const database = openTestJournalHostDatabase(root)
    let reads = 0
    let readsAfterAbort = 0
    const openSource = (path: string) => {
      const source = new Database(path, { readonly: true, fileMustExist: true })
      const prepare = source.prepare.bind(source)
      source.prepare = (sql: string) => {
        const statement = prepare(sql)
        if (!sql.includes('seq > ?')) {
          return statement
        }
        const all = statement.all.bind(statement)
        statement.all = (...args: Parameters<typeof all>) => {
          reads += 1
          if (database.importsAborted) {
            readsAfterAbort += 1
          }
          // The copy reads every row once; the abort lands on the verify's 4th file-side batch.
          if (reads === rows.length + 1 + 4) {
            database.abortImports()
          }
          return all(...args)
        }
        return statement
      }
      return source
    }

    await expect(
      importChat('session-verify', directory, { batchRows: 1, openSource })
    ).rejects.toBeInstanceOf(JournalImportAbortedError)

    expect(readsAfterAbort).toBeLessThanOrEqual(1)
    expect(readJournalSessionEpoch(database.db, 'session-verify')).toBeNull()
    expect(existsSync(legacyJournalDatabaseFile(directory))).toBe(true)
  })

  it('leaves a crashed copy’s staged rows for the next try’s first batch to delete (regression guard)', async () => {
    const { directory, epoch, rows } = await stageChat('session-crash', manyItems)
    const database = openTestJournalHostDatabase(root)
    onPublish(database, { fail: new Error('the process died before the publish') })
    await expect(importChat('session-crash', directory, { batchRows: 2 })).rejects.toThrow(
      'the process died'
    )
    expect(database.db.prepare('SELECT count(*) AS n FROM journal_rows').get()).toEqual({
      n: rows.length
    })
    vi.restoreAllMocks()
    closeTestJournalHostDatabase(root)

    await importChat('session-crash', directory, { batchRows: 2 })

    const db = openTestJournalHostDatabase(root).db
    expect([...iterateJournalEpochRows(db, 'session-crash', epoch)]).toEqual(rows)
    expect(db.prepare('SELECT count(*) AS n FROM journal_rows').get()).toEqual({ n: rows.length })
  })
})

describe('each task’s end, paced by the background copy (C3)', () => {
  it('ends every copy, delete and verify batch through the caller’s yield', async () => {
    const { directory, rows } = await stageChat('session-paced', manyItems)
    const yieldTask = vi.fn(() => new Promise<void>((resolve) => setImmediate(resolve)))

    const result = await importChat('session-paced', directory, { batchRows: 2, yieldTask })

    expect(result.outcome).toBe('imported')
    // Between copy batches, between each side's verify batches, and after the publish.
    const batches = Math.ceil(rows.length / 2) + (rows.length % 2 === 0 ? 1 : 0)
    expect(yieldTask.mock.calls.length).toBeGreaterThanOrEqual(3 * (batches - 1) + 1)
  })

  it('ends every fold batch of a missing status row through the caller’s yield', async () => {
    const { directory } = await stageChat('session-rowless', manyItems)
    await importChat('session-rowless', directory)
    const database = openTestJournalHostDatabase(root)
    database.db.prepare('DELETE FROM journal_session_state').run()
    const yieldTask = vi.fn(() => new Promise<void>((resolve) => setImmediate(resolve)))

    const written = await backfillJournalSessionStatus(database, 'session-rowless', {
      batchRows: 2,
      yieldTask
    })

    expect(written).not.toBeNull()
    expect(yieldTask.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('each step of a copy is a task of its own (R4P-2)', () => {
  it('yields between the copy, both sides of the verify and the publish, even for one batch', async () => {
    const { directory, rows } = await stageChat('session-small', manyItems)
    expect(rows.length).toBeLessThan(512)
    const database = openTestJournalHostDatabase(root)
    const steps: string[] = []
    const copy = database.unsyncedTransaction.bind(database)
    vi.spyOn(database, 'unsyncedTransaction').mockImplementation((run) => {
      steps.push('copy')
      return copy(run)
    })
    const publish = database.transaction.bind(database)
    vi.spyOn(database, 'transaction').mockImplementation((run) => {
      if (database.db.pragma('synchronous', { simple: true }) !== 1) {
        steps.push('publish')
      }
      return publish(run)
    })
    const yieldTask = vi.fn(async () => {
      steps.push('yield')
      await new Promise<void>((resolve) => setImmediate(resolve))
    })

    await importChat('session-small', directory, { yieldTask })

    // The leftover delete and the one copy batch, then the verify's file side, its copy side and
    // the publish, each after a yield.
    const fromCopy = steps.slice(steps.lastIndexOf('copy'))
    expect(
      fromCopy.slice(0, fromCopy.indexOf('publish')).filter((s) => s === 'yield')
    ).toHaveLength(3)
  })
})

describe('each task’s share of a chat’s bytes (C3)', () => {
  it('splits a batch so no part holds more than its share of row JSON; a larger row goes alone', () => {
    const row = (seq: number, size: number) => ({ seq, ts: seq, rowJson: 'x'.repeat(size) })

    const parts = [
      ...charBoundedBatches(
        [{ rows: [row(1, 40), row(2, 40), row(3, 300), row(4, 40), row(5, 40)], last: true }],
        100
      )
    ]

    expect(parts.map((part) => part.rows.map((r) => r.seq))).toEqual([[1, 2], [3], [4, 5]])
    expect(parts.map((part) => part.last)).toEqual([false, false, true])
  })

  it('verifies and folds a chat of large rows a part per task, and copies its page in one commit', async () => {
    const { directory, rows } = await stageChat('session-large', manyItems)
    const database = openTestJournalHostDatabase(root)
    const batch = vi.spyOn(database, 'unsyncedTransaction')
    const yieldTask = vi.fn(() => new Promise<void>((resolve) => setImmediate(resolve)))

    await importChat('session-large', directory, { batchChars: 1, yieldTask })

    // The leftover delete, then the whole page in one commit: more commits mean more checkpoints.
    expect(batch).toHaveBeenCalledTimes(2)
    // Each row of both verify sides is a task of its own.
    expect(yieldTask.mock.calls.length).toBeGreaterThanOrEqual(2 * (rows.length - 1) + 1)

    database.db.prepare('DELETE FROM journal_session_state').run()
    const folded = vi.fn(() => new Promise<void>((resolve) => setImmediate(resolve)))
    await backfillJournalSessionStatus(database, 'session-large', {
      batchChars: 1,
      yieldTask: folded
    })
    expect(folded.mock.calls.length).toBeGreaterThanOrEqual(rows.length - 1)
  })

  it('splits a copy commit only past its own share, so only a page of huge rows splits', async () => {
    const { directory, rows } = await stageChat('session-huge', manyItems)
    const database = openTestJournalHostDatabase(root)
    const batch = vi.spyOn(database, 'unsyncedTransaction')

    await importChat('session-huge', directory, { commitChars: 1 })

    expect(batch).toHaveBeenCalledTimes(rows.length + 1)
  })
})

describe('a file written after its copy began verifying (T20)', () => {
  it('keeps the file, and the next try sets it aside rather than losing what was written', async () => {
    const { directory, epoch, rows } = await stageChat('session-moved', manyItems)
    const database = openTestJournalHostDatabase(root)
    // An older build on a shared profile appends to the file between the publish and the delete.
    const publish = onPublish(database, {
      after: () => {
        const legacy = new Database(legacyJournalDatabaseFile(directory))
        const last = rows.at(-1)!
        legacy
          .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
          .run('session-moved', epoch, last.seq + 1, last.ts + 1, last.rowJson)
        legacy.close()
      }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await importChat('session-moved', directory)

    expect(result.outcome).toBe('imported')
    expect(existsSync(legacyJournalDatabaseFile(directory))).toBe(true)
    publish.mockRestore()
    expect((await importChat('session-moved', directory)).outcome).toBe('kept')
    expect(
      database.db
        .prepare('SELECT tip FROM journal_set_aside WHERE session_id = ?')
        .get('session-moved')
    ).toEqual({ tip: rows.length + 1 })
  })

  it('keeps a file written while the verify reads the copy back, after it read the file', async () => {
    const { directory, epoch, rows } = await stageChat('session-during', manyItems)
    let reads = 0
    let written = false
    // The source's prepare caches statements, so wrap each one once.
    const wrapped = new WeakSet<object>()
    const openSource = (path: string) => {
      const source = new Database(path, { readonly: true, fileMustExist: true })
      const prepare = source.prepare.bind(source)
      source.prepare = (sql: string) => {
        const statement = prepare(sql)
        if (!sql.includes('seq > ?') || wrapped.has(statement)) {
          return statement
        }
        wrapped.add(statement)
        const all = statement.all.bind(statement)
        statement.all = (...args: Parameters<typeof all>) => {
          reads += 1
          // batchRows 1: the copy reads rows.length + 1 pages, the verify's file side as many again.
          if (reads === 2 * (rows.length + 1)) {
            // An older build appends while the copy side is still being read back.
            setImmediate(() => {
              const legacy = new Database(legacyJournalDatabaseFile(directory))
              const last = rows.at(-1)!
              legacy
                .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
                .run('session-during', epoch, last.seq + 1, last.ts + 1, last.rowJson)
              legacy.close()
              written = true
            })
          }
          return all(...args)
        }
        return statement
      }
      return source
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await importChat('session-during', directory, { batchRows: 1, openSource })

    expect(written).toBe(true)
    expect(result.outcome).toBe('imported')
    expect(existsSync(legacyJournalDatabaseFile(directory))).toBe(true)
  })
})
