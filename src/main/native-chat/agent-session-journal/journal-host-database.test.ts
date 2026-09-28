// The one connection every chat's writes share: its transactions, its busy handling, and the order
// in which it closes at quit.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { spawnProcess } from '../../../shared/child-process/run-process'
import { tearDownRuntime } from '../../runtime/structured-agent-session-runtime-teardown'
import { journalDatabasePath } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import { deleteJournalBlock, journalRowId } from './journal-row-table'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function text(value: string) {
  return {
    kind: 'message' as const,
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text: value }]
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-host-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the shared connection', () => {
  // T8: another connection holding the write lock makes an append wait, not fail.
  it('waits out another writer instead of failing the append', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const holder = spawnProcess({
      program: process.execPath,
      args: [
        '-e',
        `const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1])
db.exec('BEGIN IMMEDIATE')
process.stdout.write('holding')
setTimeout(() => { db.exec('COMMIT'); db.close() }, 200)`,
        journalDatabasePath(root)
      ],
      timeoutMs: 30_000
    })
    const exited = new Promise<number | null>((resolve) => holder.once('exit', resolve))
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))

    await expect(
      journal.appendItem(item(1), text('after the wait'), { fence: 1 })
    ).resolves.toBeDefined()
    expect(await exited).toBe(0)
  })

  // The #22993 companion: a transaction that cannot begin fails that write alone.
  it('fails only the write whose transaction could not begin', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const database = openTestJournalHostDatabase(root)
    const exec = database.db.exec.bind(database.db)
    const busy = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5
    })
    vi.spyOn(database.db, 'exec').mockImplementationOnce(() => {
      throw busy
    })

    await expect(journal.appendItem(item(1), text('refused'), { fence: 1 })).rejects.toBe(busy)
    vi.mocked(database.db.exec).mockImplementation(exec)
    await expect(journal.appendItem(item(2), text('next'), { fence: 1 })).resolves.toBeDefined()
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([text('next')])
  })

  it('refuses a transaction body that awaits', () => {
    const database = openTestJournalHostDatabase(root)
    expect(() => database.transaction(async () => undefined)).toThrow('must not await')
    // Rolled back: the connection is free for the next transaction.
    expect(database.db.isTransaction).toBe(false)
  })
})

describe('quit', () => {
  // T-quit-drain: a sink write still in flight while the host flushes lands before the one
  // connection closes, because the connection closes last.
  it('closes the one connection only after the host has flushed what was in flight', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const database = openTestJournalHostDatabase(root)
    const installed = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `flushAllStreamedEvents` on the host.
      host: {
        flushAllStreamedEvents: async () => {
          // A child's last row, delivered while quit is draining its sink.
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          await journal.appendItem(item(1), text('written during quit'), { fence: 1 })
        }
      } as never,
      adapter: { closeAll: async () => undefined },
      journalDatabase: database,
      waitForRecovery: async () => undefined
    }

    await tearDownRuntime(installed, 'quit')

    expect(database.isClosed).toBe(true)
    closeTestJournalHostDatabases()
    const reopened = openTestJournalHostDatabase(root)
    expect(
      readTestJournalRows(reopened.db, IDENTITY.sessionId, journal.epoch).map((row) => row.seq)
    ).toEqual([1, 2])
  })
})

describe('handing freed pages back', () => {
  // About one page per row; each block frees more than one reclaim step's worth.
  function fillBlock(
    db: ReturnType<typeof openTestJournalHostDatabase>['db'],
    block: number
  ): void {
    const insert = db.prepare('INSERT INTO journal_rows (id, ts, row_json) VALUES (?, ?, ?)')
    db.exec('BEGIN')
    for (let seq = 1; seq <= 3500; seq += 1) {
      insert.run(journalRowId(block, seq), 1, 'x'.repeat(3500))
    }
    db.exec('COMMIT')
  }

  it('reclaims what a delete frees while a pass is already running', async () => {
    const database = openTestJournalHostDatabase(root)
    const freePages = () => Number(database.db.pragma('freelist_count', { simple: true }))
    fillBlock(database.db, 0)
    fillBlock(database.db, 1)
    deleteJournalBlock(database.db, 0)
    const pass = database.reclaimFreePages()
    // The pass takes its first step, then a second chat's delete lands before its next one.
    await new Promise((resolve) => setImmediate(resolve))
    expect(freePages()).toBeGreaterThan(0)
    deleteJournalBlock(database.db, 1)

    expect(database.reclaimFreePages()).toBe(pass)
    await pass
    expect(freePages()).toBe(0)
  })
})
