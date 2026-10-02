// A missing status row written from the chat's rows alone, with no open: the row an open would
// write, folded a bounded part per task, and nothing written when the chat moved or quit stops it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  publishTestJournalEpoch,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import * as JournalOpen from './journal-open'
import {
  backfillJournalSessionStatus,
  foldJournalSessionStatus,
  writeJournalSessionStatuses,
  type FoldedJournalSessionStatus
} from './journal-session-status-backfill'
import {
  CORPUS_FENCE,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS
} from './journal-session-state-test-corpus'
import type { AgentSessionJournal } from './journal-store'

vi.mock('./journal-open', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalOpen>()
  return { ...actual, startJournalRowFold: vi.fn(actual.startJournalRowFold) }
})

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

function open(sessionId: string): Promise<AgentSessionJournal> {
  return journals.open({
    identity: identity(sessionId),
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${sessionId}-${clock}`,
    currentFence: () => CORPUS_FENCE
  })
}

const database = () => openTestJournalHostDatabase(root)
const dropRow = (sessionId: string) =>
  database().db.prepare('DELETE FROM journal_session_state WHERE session_id = ?').run(sessionId)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-backfill-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('a row from the rows alone', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)('equals the row an open writes: %s', async (name) => {
    const journal = await open(name)
    await JOURNAL_SESSION_STATE_CORPUS[name](journal)
    await journals.closeAll()
    dropRow(name)
    // What an open of the chat writes for a missing row.
    const reopened = await open(name)
    reopened.backfillSessionStatus()
    const byOpen = readTestJournalSessionStatus(root, name)
    await journals.closeAll()
    dropRow(name)

    const derived = await backfillJournalSessionStatus(database(), name)

    expect(derived?.status ?? null).toEqual(byOpen)
    expect(readTestJournalSessionStatus(root, name)).toEqual(byOpen)
  })

  it('equals the row an open writes for a chat whose history is corrupt', async () => {
    const journal = await open('corrupt')
    await JOURNAL_SESSION_STATE_CORPUS['working subagent roster'](journal)
    const tip = journal.cursor()
    await journals.closeAll()
    insertTestJournalRowJson(database().db, 'corrupt', tip.sequence + 1, '{"not a row"')
    dropRow('corrupt')
    const reopened = await open('corrupt')
    reopened.backfillSessionStatus()
    const byOpen = readTestJournalSessionStatus(root, 'corrupt')
    await journals.closeAll()
    dropRow('corrupt')

    const derived = await backfillJournalSessionStatus(database(), 'corrupt')

    // The rebuild the corruption owes decides the roster, so neither row counts it as live work.
    expect(derived?.load.corrupt).toBe(true)
    expect(byOpen?.liveChildWork).toBe(false)
    expect(derived?.status ?? null).toEqual(byOpen)
  })

  it('folds a large chat a bounded part per task', async () => {
    const journal = await open('large')
    const text = 'x'.repeat(2_000)
    for (let index = 0; index < 200; index += 1) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `note-${index}` },
        { kind: 'status', text: `${index} ${text}` },
        { fence: CORPUS_FENCE, turnScope: { kind: 'thread' } }
      )
    }
    await journals.closeAll()
    dropRow('large')
    // Characters of row JSON folded since the last yield: what one task does.
    let sinceYield = 0
    let largest = 0
    const actual = await vi.importActual<typeof JournalOpen>('./journal-open')
    vi.mocked(JournalOpen.startJournalRowFold).mockImplementationOnce((input) => {
      const fold = actual.startJournalRowFold(input)
      return {
        add: (entry) => {
          sinceYield += entry.rowJson.length
          return fold.add(entry)
        },
        finish: fold.finish
      }
    })
    const budget = 20_000

    const derived = await backfillJournalSessionStatus(database(), 'large', {
      batchRows: 64,
      batchChars: budget,
      yieldTask: async () => {
        largest = Math.max(largest, sinceYield)
        sinceYield = 0
      }
    })

    largest = Math.max(largest, sinceYield)
    expect(derived?.status.lifecycle).toBe('idle')
    // 200 rows of about 2 KB: many parts, none over the budget.
    expect(largest).toBeGreaterThan(budget / 2)
    expect(largest).toBeLessThanOrEqual(budget)
  })

  it('writes nothing when the chat moved during the fold, quit stopped it, or it has a row', async () => {
    const journal = await open('moving')
    await JOURNAL_SESSION_STATE_CORPUS.settled(journal)
    dropRow('moving')
    // An append lands between parts: the fold read a tip the chat has left.
    let appended = false
    const moved = await backfillJournalSessionStatus(database(), 'moving', {
      batchRows: 1,
      yieldTask: async () => {
        if (!appended) {
          appended = true
          dropRow('moving')
          await journal.appendItem(
            { provider: 'orca', clientMessageId: 'late' },
            { kind: 'status', text: 'late' },
            { fence: CORPUS_FENCE, turnScope: { kind: 'thread' } }
          )
          dropRow('moving')
        }
      }
    })
    expect(moved).toBeNull()
    expect(readTestJournalSessionStatus(root, 'moving')).toBeNull()

    const quit = new AbortController()
    const stopped = await backfillJournalSessionStatus(database(), 'moving', {
      batchRows: 1,
      signal: quit.signal,
      yieldTask: async () => quit.abort()
    })
    expect(stopped).toBeNull()
    expect(readTestJournalSessionStatus(root, 'moving')).toBeNull()

    // Still in a per-chat file, or never written: no epoch here.
    expect(await backfillJournalSessionStatus(database(), 'never-written')).toBeNull()

    await backfillJournalSessionStatus(database(), 'moving')
    const row = readTestJournalSessionStatus(root, 'moving')
    expect(row).not.toBeNull()
    // A row already there is never rewritten.
    expect(await backfillJournalSessionStatus(database(), 'moving')).toBeNull()
  })

  it('writes a whole batch in one transaction, each row the row an open writes', async () => {
    const byOpen = new Map<string, unknown>()
    for (const name of JOURNAL_SESSION_STATE_CASES) {
      await JOURNAL_SESSION_STATE_CORPUS[name](await open(name))
    }
    await journals.closeAll()
    for (const name of JOURNAL_SESSION_STATE_CASES) {
      dropRow(name)
      ;(await open(name)).backfillSessionStatus()
      byOpen.set(name, readTestJournalSessionStatus(root, name))
      await journals.closeAll()
      dropRow(name)
    }
    const folded: FoldedJournalSessionStatus[] = []
    for (const name of JOURNAL_SESSION_STATE_CASES) {
      folded.push((await foldJournalSessionStatus(database(), name))!)
    }
    const transaction = vi.spyOn(database(), 'transaction')

    const written = writeJournalSessionStatuses(database(), folded)

    expect(transaction).toHaveBeenCalledOnce()
    expect(written.map(({ sessionId }) => sessionId)).toEqual([...JOURNAL_SESSION_STATE_CASES])
    for (const name of JOURNAL_SESSION_STATE_CASES) {
      expect(readTestJournalSessionStatus(root, name)).toEqual(byOpen.get(name))
    }
  })

  it('skips only the chats in a batch that moved, got a row or a new history since their fold', async () => {
    const ids = ['steady', 'appended', 'rowed', 'replaced']
    const journalsById = new Map<string, AgentSessionJournal>()
    for (const sessionId of ids) {
      const journal = await open(sessionId)
      await JOURNAL_SESSION_STATE_CORPUS.settled(journal)
      journalsById.set(sessionId, journal)
      dropRow(sessionId)
    }
    const folded: FoldedJournalSessionStatus[] = []
    for (const sessionId of ids) {
      folded.push((await foldJournalSessionStatus(database(), sessionId))!)
    }
    // Between the fold and the batch's write: a send lands, an open writes the row, a rebuild
    // starts a new history.
    await journalsById
      .get('appended')!
      .appendItem(
        { provider: 'orca', clientMessageId: 'late' },
        { kind: 'status', text: 'late' },
        { fence: CORPUS_FENCE, turnScope: { kind: 'thread' } }
      )
    dropRow('appended')
    journalsById.get('rowed')!.backfillSessionStatus()
    const rowedBefore = readTestJournalSessionStatus(root, 'rowed')
    publishTestJournalEpoch(database().db, 'replaced', 'epoch-replaced-later')

    const written = writeJournalSessionStatuses(database(), folded)

    expect(written.map(({ sessionId }) => sessionId)).toEqual(['steady'])
    expect(readTestJournalSessionStatus(root, 'steady')).toEqual(folded[0]!.status)
    expect(readTestJournalSessionStatus(root, 'appended')).toBeNull()
    expect(readTestJournalSessionStatus(root, 'rowed')).toEqual(rowedBefore)
    expect(readTestJournalSessionStatus(root, 'replaced')).toBeNull()
  })
})
