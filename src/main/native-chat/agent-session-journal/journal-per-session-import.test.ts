// A chat's per-chat journal file from an earlier build is copied into the host's one database on
// that chat's open: verbatim, and retired only after the copy commits. A file that reappears after
// a downgrade is the newer history, and is copied again.

import type * as NodeFs from 'node:fs'
import { existsSync, renameSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import Database from '../../sqlite/sync-database'
import { createStructuredAgentSessionRestartOfferWithdrawal } from '../agent-session-wire/structured-agent-session-restart-offer-withdrawal'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import { journalDirectoryFor, legacyJournalDatabaseFile } from './journal-paths'
import { importPerSessionJournal } from './journal-per-session-import'
import { JOURNAL_OLDER_BUILD_DISCLOSURE_IDENTITY } from './journal-per-session-reimport'
import type { JournalStoredRow } from './journal-row-table'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-legacy',
  workspaceId: 'ws-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function legacyDir(): string {
  return journalDirectoryFor(root, IDENTITY)
}

/** Real rows, written by today's store into a scratch database, as an earlier build wrote them. */
async function historyRows(
  epoch = 'epoch-from-the-earlier-build',
  reply = 'On it.'
): Promise<{ epoch: string; rows: JournalStoredRow[] }> {
  const scratch = join(root, `scratch-${epoch}`)
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: scratch,
    now: () => (clock += 1),
    mintEpoch: () => epoch
  })
  await journal.appendSubmission({
    clientMessageId: 'client-1',
    payloadFingerprint: 'fp-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'add a retry' }] },
    fence: 1,
    handoverRecorded: true
  })
  await journal.appendItem(
    item(1),
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: reply }] },
    { fence: 1 }
  )
  const rows = readTestJournalRows(
    openTestJournalHostDatabase(scratch).db,
    IDENTITY.sessionId,
    journal.epoch
  )
  return { epoch: journal.epoch, rows }
}

/** The per-chat file an earlier build left, in its own schema. */
async function writeLegacyJournal(epoch: string, rows: readonly JournalStoredRow[]): Promise<void> {
  const path = legacyJournalDatabaseFile(legacyDir())
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`
CREATE TABLE journal_rows (session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (session_id, epoch, seq));
CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE journal_repairs (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  content_from INTEGER NOT NULL, repaired_at INTEGER NOT NULL);`)
    db.pragma('user_version = 2')
    const insert = db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(IDENTITY.sessionId, row.epoch, row.seq, row.ts, row.rowJson)
    }
    if (rows.length > 0) {
      db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(IDENTITY.sessionId, epoch, 1)
    }
  } finally {
    db.close()
  }
}

/** Every directory an import retired this chat's files to. */
async function retired(): Promise<string[]> {
  const parent = dirname(legacyDir())
  const prefix = `${legacyDir().slice(parent.length + 1)}.imported-`
  return (await readdir(parent)).filter((name) => name.startsWith(prefix))
}

function texts(journal: { snapshot: () => { items: { body: unknown }[] } }): string {
  return JSON.stringify(journal.snapshot().items.map((entry) => entry.body))
}

function renameFails(): void {
  vi.mocked(renameSync).mockImplementation(() => {
    throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
  })
}

async function renameWorks(): Promise<void> {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  vi.mocked(renameSync).mockImplementation(actual.renameSync)
}

function openChat() {
  return journals.open({ identity: IDENTITY, stateDirectory: root, now: () => (clock += 1) })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-per-session-import-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await renameWorks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('importing a per-chat journal', () => {
  it('copies the history verbatim on first open and retires the file', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)

    const journal = await openChat()

    expect(journal.epoch).toBe(epoch)
    expect(journal.cursor()).toEqual({ epoch, sequence: rows.length })
    expect(
      readTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId, epoch)
    ).toEqual(rows)
    expect(existsSync(legacyDir())).toBe(false)
    expect(await retired()).toEqual([expect.stringMatching(/\.imported-epoch-fr-\d+$/)])
  })

  // T-B3: the upgrade restart is the restart that produced the offers. A new epoch or renumbered
  // rows would silently withdraw every "resume after update" offer.
  it('keeps a restart offer taken before the upgrade', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `movedOn` reads only the session id and the journal cursor.
    const marker = {
      sessionId: IDENTITY.sessionId,
      journalCursor: { epoch, sequence: rows.length }
    } as AgentSessionResumeMarker

    const journal = await openChat()
    const withdrawal = createStructuredAgentSessionRestartOfferWithdrawal({
      sessions: new Map([[IDENTITY.sessionId, { journal, child: null }]]),
      now: () => clock,
      enqueue: (operation) => operation()
    })

    expect(withdrawal.movedOn(marker)).toBe(false)
  })

  // T-R2B1: the copy committed and only the rename failed. Rows appended since, a restart, and a
  // reopen with the file still there: nothing is copied again, and nothing is lost.
  it('never copies the same file again after a failed rename, across a restart', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    renameFails()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const journal = await openChat()
    await journal.appendItem(
      item(2),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after the upgrade' }] },
      { fence: 1 }
    )
    expect(existsSync(legacyJournalDatabaseFile(legacyDir()))).toBe(true)
    // The process exits: the database closes and the owner lock goes with it.
    await journals.closeAll()

    const reopened = await openChat()
    expect(reopened.cursor()).toEqual({ epoch, sequence: rows.length + 1 })
    expect(texts(reopened)).toContain('after the upgrade')
    expect(texts(reopened)).not.toContain(JOURNAL_OLDER_BUILD_DISCLOSURE_IDENTITY.clientMessageId)
  })

  // T-import-transient: a read that fails leaves the file for the next open, which imports it.
  it('leaves the file in place on a failed read, and refuses the open rather than serve it empty', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    const database = openTestJournalHostDatabase(root)
    const io = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })

    expect(() =>
      importPerSessionJournal({
        database,
        identity: IDENTITY,
        legacyDirectory: legacyDir(),
        openSource: () => {
          throw io
        }
      })
    ).toThrow(io)
    expect(existsSync(legacyJournalDatabaseFile(legacyDir()))).toBe(true)
    expect(
      database.db.prepare('SELECT count(*) AS total FROM journal_sessions').get()
    ).toMatchObject({ total: 0 })

    const journal = await openChat()
    expect(journal.cursor()).toEqual({ epoch, sequence: rows.length })
    expect(existsSync(legacyDir())).toBe(false)
  })

  // A file that is not a database stays where it is, and the chat says it cannot be loaded.
  it('refuses the open of a legacy file that is not a database, and keeps the file', async () => {
    await mkdir(legacyDir(), { recursive: true })
    await writeFile(legacyJournalDatabaseFile(legacyDir()), 'not a database '.repeat(512))

    await expect(openChat()).rejects.toMatchObject({ errcode: 26 })

    expect(await readdir(legacyDir())).toEqual(['journal.db'])
  })

  it('leaves a never-written file in place until the chat it belongs to is founded', async () => {
    await writeLegacyJournal('unused', [])
    await mkdir(legacyDir(), { recursive: true })
    await writeFile(join(legacyDir(), 'log.jsonl'), '{"kind":"epoch","v":1,"seq":1}\n', 'utf8')

    const journal = await openChat()

    // The pre-SQLite transcript beside it is still there to explain the empty chat.
    expect(JSON.stringify(journal.snapshot().items)).toContain('log.jsonl')
    await journals.closeAll()
    await openChat()
    expect(existsSync(legacyDir())).toBe(false)
  })

  // A crash between creating the file and giving it the schema: the chat opens with no history, as
  // it did when each chat opened its own file, and the file retires like any never-written one.
  it.each([
    ['empty', async (path: string) => writeFile(path, '')],
    [
      'schema-less',
      async (path: string) => {
        const db = new Database(path)
        db.pragma('journal_mode = WAL')
        db.close()
      }
    ]
  ])('opens a chat whose per-chat file is %s as having no history', async (_shape, create) => {
    await mkdir(legacyDir(), { recursive: true })
    await create(legacyJournalDatabaseFile(legacyDir()))

    const journal = await openChat()

    expect(journal.snapshot().items).toEqual([])
    await journals.closeAll()
    await openChat()
    expect(existsSync(legacyDir())).toBe(false)
    expect(await retired()).toHaveLength(1)
  })

  // T-B5: a downgrade, an older build writing the chat's history to a new per-chat file, and a
  // re-upgrade — twice. The newer history wins each time, says so, and each file retires to its
  // own name.
  it('copies the newer history an older build wrote, on every re-upgrade', async () => {
    const first = await historyRows()
    await writeLegacyJournal(first.epoch, first.rows)
    const upgraded = await openChat()
    await upgraded.appendItem(
      item(2),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'this build' }] },
      { fence: 1 }
    )
    await journals.closeAll()

    for (const [cycle, epoch] of ['epoch-downgrade-one', 'epoch-downgrade-two'].entries()) {
      const older = await historyRows(epoch, `older build, cycle ${cycle + 1}`)
      await writeLegacyJournal(older.epoch, older.rows)
      await journals.closeAll()

      const reopened = await openChat()
      expect(reopened.epoch).toBe(epoch)
      expect(texts(reopened)).toContain(`older build, cycle ${cycle + 1}`)
      expect(texts(reopened)).not.toContain('this build')
      expect(texts(reopened)).toContain('continued in an older version of Orca')
      expect(existsSync(legacyDir())).toBe(false)
      await journals.closeAll()
    }
    expect(await retired()).toHaveLength(3)
  })

  // N-R3.1: the rename failed, this build appended, and an older build then appended to that same
  // file. Both advanced from the recorded tip under one epoch, so the copy takes a fresh one: a
  // reader at this build's tip resets instead of silently skipping the older build's rows.
  it('gives the copy a fresh epoch when both builds wrote past the same recorded tip', async () => {
    const { epoch, rows } = await historyRows()
    await writeLegacyJournal(epoch, rows)
    renameFails()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const journal = await openChat()
    await journal.appendItem(
      item(2),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'this build' }] },
      { fence: 1 }
    )
    await journals.closeAll()
    const olderRow = { ...JSON.parse(rows.at(-1)!.rowJson), seq: rows.length + 1 }
    olderRow.body = {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'older' }]
    }
    olderRow.itemId = `${olderRow.itemId}-older`
    const legacy = new Database(legacyJournalDatabaseFile(legacyDir()))
    legacy
      .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
      .run(IDENTITY.sessionId, epoch, rows.length + 1, 1, JSON.stringify(olderRow))
    legacy.close()
    await renameWorks()

    const reopened = await openChat()

    expect(reopened.epoch).not.toBe(epoch)
    expect(texts(reopened)).toContain('older')
    expect(texts(reopened)).toContain('continued in an older version of Orca')
    expect(reopened.readSince({ epoch, sequence: rows.length + 1 })).toEqual({
      ok: false,
      reset: 'epoch_changed'
    })
    expect(existsSync(legacyDir())).toBe(false)
  })
})
