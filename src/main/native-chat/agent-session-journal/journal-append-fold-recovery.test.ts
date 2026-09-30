// An append folds its row inside the transaction, so the chat's stored state can describe it. A
// transaction that fails after that fold leaves the fold ahead of the disk: the chat re-folds from
// what committed, or closes when a stranded connection could still show it the uncommitted row.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  loadTestJournal,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { applyJournalRow, renderJournalState } from './journal-reducer'
import type * as JournalReducer from './journal-reducer'
import { readJournalSessionState } from './journal-session-state'
import type { AgentSessionJournal } from './journal-store'

vi.mock('./journal-reducer', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalReducer>()
  return { ...actual, applyJournalRow: vi.fn(actual.applyJournalRow) }
})

const SESSION = 'session-fold'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION,
  workspaceId: 'ws-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-fold' }
}

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000

function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-fold'
  })
}

function note(journal: AgentSessionJournal, id: string) {
  return journal.appendItem(
    { provider: 'orca', clientMessageId: id },
    { kind: 'status', text: id },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
}

/** The chat's fold, as a reader of it sees it. */
function foldOf(journal: AgentSessionJournal) {
  return {
    cursor: journal.cursor(),
    snapshot: journal.snapshot(),
    lastActivityAt: journal.lastActivityAt(),
    highestFence: journal.highestFence()
  }
}

/** The same, from a fresh replay of what is on disk. */
function durableFold() {
  const loaded = loadTestJournal(root, SESSION)!
  return {
    cursor: { epoch: loaded.state.epoch, sequence: loaded.state.lastSequence },
    snapshot: renderJournalState(loaded.state),
    lastActivityAt: loaded.state.lastActivityAt,
    highestFence: loaded.state.highestFence
  }
}

/** Fails the next statement(s) the connection runs whose SQL is in `failing`, once each. */
function failOnce(failing: string[]): void {
  const database = openTestJournalHostDatabase(root)
  const connection = database.db
  const exec = connection.exec.bind(connection)
  const pending = new Set(failing)
  vi.spyOn(connection, 'exec').mockImplementation((sql: string) => {
    if (pending.delete(sql)) {
      throw new Error(`${sql} failed: disk I/O error`)
    }
    exec(sql)
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-fold-recovery-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('an append whose transaction fails after its row folded', () => {
  it('re-folds from disk when the fold itself throws part-way (T1a)', async () => {
    const journal = await open()
    await note(journal, 'first')
    const stateBefore = readJournalSessionState(openTestJournalHostDatabase(root).db, SESSION)
    // One mutation lands, then the fold throws: the in-place apply cannot be undone.
    vi.mocked(applyJournalRow).mockImplementationOnce((state, row) => {
      state.lastSequence = row.seq
      throw new Error('fold failed part-way')
    })

    await expect(note(journal, 'second')).rejects.toThrow('fold failed part-way')

    expect(durableFold().cursor.sequence).toBe(2)
    expect(foldOf(journal)).toEqual(durableFold())
    expect(readJournalSessionState(openTestJournalHostDatabase(root).db, SESSION)).toEqual(
      stateBefore
    )
    // The next append takes the sequence the failed one could not.
    await expect(note(journal, 'third')).resolves.toMatchObject({ cursor: { sequence: 3 } })
  })

  it('re-folds from disk when COMMIT fails and the rollback goes through (T1b)', async () => {
    const journal = await open()
    await note(journal, 'first')
    const stateBefore = readJournalSessionState(openTestJournalHostDatabase(root).db, SESSION)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failOnce(['COMMIT'])

    await expect(note(journal, 'second')).rejects.toThrow('COMMIT failed')

    expect(durableFold().cursor.sequence).toBe(2)
    expect(foldOf(journal)).toEqual(durableFold())
    expect(readJournalSessionState(openTestJournalHostDatabase(root).db, SESSION)).toEqual(
      stateBefore
    )
    await expect(note(journal, 'third')).resolves.toMatchObject({ cursor: { sequence: 3 } })
  })

  it('closes the chat rather than re-reading a stranded connection (T1c)', async () => {
    const journal = await open()
    await note(journal, 'first')
    const stranded = vi.fn()
    journal.observeStranded(stranded)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failOnce(['COMMIT', 'ROLLBACK'])

    await expect(note(journal, 'second')).rejects.toThrow('COMMIT failed')

    expect(stranded).toHaveBeenCalledOnce()
    // Closed: no later write can land past a row that never committed.
    await expect(note(journal, 'third')).rejects.toMatchObject({ code: 'journal_closed' })
    // The host database's own retry rolls the stranded transaction back on its next use.
    expect(openTestJournalHostDatabase(root).db.isTransaction).toBe(false)
    expect(durableFold().cursor.sequence).toBe(2)
    const reopened = await open()
    expect(foldOf(reopened)).toEqual(durableFold())
    await expect(note(reopened, 'fourth')).resolves.toMatchObject({ cursor: { sequence: 3 } })
  })
})
