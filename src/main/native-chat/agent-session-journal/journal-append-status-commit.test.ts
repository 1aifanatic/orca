// An append's rows, the send ledger answer riding it, and the chat status they give commit in ONE
// transaction, the status written once from the fold holding every row; a failed COMMIT leaves no
// answer, no status write and no fold change.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  loadTestJournal,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import { renderJournalState } from './journal-reducer'
import type { JournalOperationReceipt } from './journal-row-writer'
import { deriveJournalSessionStatus } from './journal-session-state'
import type { AgentSessionJournal } from './journal-store'

const SESSION = 'session-append'
const FENCE = 3
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION,
  workspaceId: 'ws-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-append' }
}

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-append-status-commit-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const db = () => openTestJournalHostDatabase(root).db
const stored = () => readTestJournalSessionStatus(root, SESSION)

async function openChat(): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-1',
    currentFence: () => FENCE
  })
  // Committed status writes: a rolled-back transaction takes its trigger rows with it.
  db().exec(`
    CREATE TEMP TABLE IF NOT EXISTS status_writes (session_id TEXT);
    CREATE TEMP TABLE IF NOT EXISTS ledger_answers (operation_id TEXT);
    CREATE TEMP TRIGGER IF NOT EXISTS count_status_insert AFTER INSERT ON main.journal_session_state
      BEGIN INSERT INTO status_writes VALUES (new.session_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS count_status_update AFTER UPDATE ON main.journal_session_state
      BEGIN INSERT INTO status_writes VALUES (new.session_id); END;`)
  return journal
}

function statusWrites(): number {
  const row = db().prepare('SELECT COUNT(*) AS n FROM status_writes').get()
  return typeof row === 'object' && row !== null && 'n' in row ? Number(row.n) : -1
}

function ledgerAnswers(): number {
  const row = db().prepare('SELECT COUNT(*) AS n FROM ledger_answers').get()
  return typeof row === 'object' && row !== null && 'n' in row ? Number(row.n) : -1
}

/** A send's ledger answer: one row inside the append's transaction, adopted after its COMMIT. */
function ledgerReceipt(): JournalOperationReceipt & { adopted: number; inTransaction: boolean[] } {
  const inTransaction: boolean[] = []
  const receipt = {
    adopted: 0,
    inTransaction,
    write: (connection: ReturnType<typeof db>) => {
      receipt.inTransaction.push(connection.isTransaction)
      connection.prepare('INSERT INTO ledger_answers VALUES (?)').run('op-1')
    },
    committed: () => {
      receipt.adopted += 1
    }
  }
  return receipt
}

/** What a fresh open of the chat derives, read back from disk. */
function freshDerivation() {
  const loaded = loadTestJournal(root, SESSION)!
  return deriveJournalSessionStatus(loaded.state, {
    settlesRosters: !loaded.corrupt,
    currentFence: FENCE
  })
}

/** Fails the next COMMIT the connection runs, once. */
function failNextCommit(): void {
  const connection = db()
  const exec = connection.exec.bind(connection)
  let failing = true
  vi.spyOn(connection, 'exec').mockImplementation((sql: string) => {
    if (failing && sql === 'COMMIT') {
      failing = false
      throw new Error('COMMIT failed: disk I/O error')
    }
    return exec(sql)
  })
}

function send(journal: AgentSessionJournal, id: string, receipt?: JournalOperationReceipt) {
  return journal.appendSubmission(
    {
      clientMessageId: id,
      payloadFingerprint: `fp-${id}`,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
      fence: FENCE,
      handoverRecorded: true
    },
    undefined,
    receipt
  )
}

function startFailureBatch() {
  return {
    settlementId: 'start-failure:gen-1',
    fence: FENCE,
    recovered: true as const,
    mutations: [
      {
        kind: 'item' as const,
        identity: { provider: 'orca', clientMessageId: 'start-failure:gen-1' } as const,
        body: { kind: 'status' as const, tone: 'error' as const, text: 'Codex did not start.' },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ],
    rejectsQueued: agentSessionFailureWords(agentSessionFailureFact('providerStartFailed'), {
      surface: 'rejection'
    })
  }
}

describe("a send's ledger answer", () => {
  it('commits with its row and a status written once, then is adopted', async () => {
    const journal = await openChat()
    const writesBefore = statusWrites()
    const receipt = ledgerReceipt()

    await send(journal, 'send-1', receipt)

    expect(receipt.inTransaction).toEqual([true])
    expect(receipt.adopted).toBe(1)
    expect(ledgerAnswers()).toBe(1)
    expect(statusWrites() - writesBefore).toBe(1)
    expect(stored()).toEqual(freshDerivation())
    expect(stored()).toMatchObject({ queuedSends: 1 })
  })

  it('leaves no answer, no status write and no fold change when the COMMIT fails', async () => {
    const journal = await openChat()
    await send(journal, 'earlier')
    const tip = journal.cursor()
    const before = stored()
    const writesBefore = statusWrites()
    const receipt = ledgerReceipt()
    failNextCommit()

    await expect(send(journal, 'send-1', receipt)).rejects.toThrow('COMMIT failed')

    expect(receipt.inTransaction).toEqual([true])
    expect(receipt.adopted).toBe(0)
    expect(ledgerAnswers()).toBe(0)
    expect(statusWrites()).toBe(writesBefore)
    expect(stored()).toEqual(before)
    expect(journal.cursor()).toEqual(tip)
    expect(journal.submission('send-1')).toBeUndefined()
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, SESSION)!.state))
  })
})

describe("a failed start's rows", () => {
  it('commit with one status write, from the fold that holds every row', async () => {
    const journal = await openChat()
    await send(journal, 'first')
    await send(journal, 'second')
    const writesBefore = statusWrites()

    await journal.appendLifecycleBatch(startFailureBatch())

    expect(statusWrites() - writesBefore).toBe(1)
    expect(stored()).toEqual(freshDerivation())
    expect(stored()).toMatchObject({ queuedSends: 0 })
  })

  it('leave no status write and no fold change when the COMMIT fails', async () => {
    const journal = await openChat()
    await send(journal, 'first')
    await send(journal, 'second')
    const tip = journal.cursor()
    const before = stored()
    const writesBefore = statusWrites()
    failNextCommit()

    await expect(journal.appendLifecycleBatch(startFailureBatch())).rejects.toThrow('COMMIT failed')

    expect(statusWrites()).toBe(writesBefore)
    expect(stored()).toEqual(before)
    expect(journal.cursor()).toEqual(tip)
    expect(journal.submissions().map((entry) => entry.dispatchState)).toEqual([
      'pending',
      'pending'
    ])
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, SESSION)!.state))
  })
})
