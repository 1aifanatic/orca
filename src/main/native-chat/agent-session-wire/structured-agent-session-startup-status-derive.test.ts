// The startup status pass's tasks: a chat with nothing to fold (no history in the host's database
// yet, or a row already) goes by without a task of its own, a long run of them still yields, and a
// chat that folds always starts a task.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as TimersPromises from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import type * as StatusBackfillModule from '../agent-session-journal/journal-session-status-backfill'
import {
  CORPUS_FENCE,
  JOURNAL_SESSION_STATE_CORPUS
} from '../agent-session-journal/journal-session-state-test-corpus'
import type { StructuredAgentSessionStartupStateDeps } from './structured-agent-session-startup-state'

// What the pass did, in order: each yield to the event loop, and each fold it started.
const trace = vi.hoisted(() => {
  const log: { events: string[] } = { events: [] }
  return log
})

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof TimersPromises>()
  return {
    ...actual,
    setImmediate: (...args: Parameters<typeof actual.setImmediate>) => {
      trace.events.push('yield')
      return actual.setImmediate(...args)
    }
  }
})

vi.mock('../agent-session-journal/journal-session-status-backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof StatusBackfillModule>()
  return {
    ...actual,
    foldJournalSessionStatus: (...args: Parameters<typeof actual.foldJournalSessionStatus>) => {
      trace.events.push(`fold:${args[1]}`)
      return actual.foldJournalSessionStatus(...args)
    }
  }
})

import { deriveMissingStatuses } from './structured-agent-session-startup-status-derive'

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-status-derive-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function record(sessionId: string): AgentSessionRecord {
  return { ...agentSessionRecordFixture(), sessionId }
}

/** Chats with a settled history in the host's database and no status row: each one folds. */
async function chatsWithHistory(sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    const journal = await journals.open({
      identity: {
        sessionId,
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
      },
      stateDirectory: root,
      mintEpoch: () => `epoch-${sessionId}`,
      currentFence: () => CORPUS_FENCE
    })
    await JOURNAL_SESSION_STATE_CORPUS.settled(journal)
  }
  await journals.closeAll()
  openTestJournalHostDatabase(root).db.exec('DELETE FROM journal_session_state')
}

function deps(seeded: string[] = []): StructuredAgentSessionStartupStateDeps {
  const stand = {
    openDeps: {
      journalDatabase: openTestJournalHostDatabase(root),
      store: { getRecord: record, listRecords: () => [] },
      logger: { warn: vi.fn(), error: vi.fn() }
    },
    canSettle: (candidate: AgentSessionRecord | null): candidate is AgentSessionRecord =>
      candidate !== null,
    seedStatus: (chat: AgentSessionRecord) => {
      seeded.push(chat.sessionId)
    },
    resolveRecovery: async () => true,
    restoreListed: async () => undefined,
    serialize: <T>(_sessionId: string, task: () => Promise<T>) => task(),
    hasSession: () => false,
    isListed: () => true,
    isDisposed: () => false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only the database, records, logger and the members above.
  return stand as unknown as StructuredAgentSessionStartupStateDeps
}

const yields = () => trace.events.filter((event) => event === 'yield').length

describe('the startup status pass over chats with nothing to fold', () => {
  it('passes them all, in order, without a task each and without a write', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `session-file-${index}`)
    const stand = deps()
    const transaction = vi.spyOn(stand.openDeps.journalDatabase, 'transaction')
    trace.events = []

    const toOpen = await deriveMissingStatuses(stand, ids)

    expect(toOpen).toEqual(ids)
    expect(trace.events.filter((event) => event.startsWith('fold:'))).toEqual([])
    expect(yields()).toBeLessThan(ids.length / 4)
    // An empty slice commits nothing.
    expect(transaction).not.toHaveBeenCalled()
  })

  it('still yields during a long run of them', async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `session-file-${index}`)
    const stand = deps()
    // Each clock read moves 3 ms: a run of skips crosses the 8 ms bound every few chats.
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 3))
    trace.events = []

    expect(await deriveMissingStatuses(stand, ids)).toEqual(ids)

    expect(yields()).toBeGreaterThanOrEqual(10)
    expect(yields()).toBeLessThan(ids.length)
  })

  it('keeps the order in a mixed pass and starts a task before each chat that folds', async () => {
    await chatsWithHistory(['session-fold-1', 'session-fold-2'])
    const ids = [
      'session-file-1',
      'session-fold-1',
      'session-file-2',
      'session-file-3',
      'session-fold-2',
      'session-file-4'
    ]
    const seeded: string[] = []
    const stand = deps(seeded)
    trace.events = []

    const toOpen = await deriveMissingStatuses(stand, ids)

    expect(toOpen).toEqual(['session-file-1', 'session-file-2', 'session-file-3', 'session-file-4'])
    expect(seeded).toEqual(['session-fold-1', 'session-fold-2'])
    for (const sessionId of ['session-fold-1', 'session-fold-2']) {
      expect(readTestJournalSessionStatus(root, sessionId)).toMatchObject({ lifecycle: 'idle' })
    }
    // A yield between the start (or the previous fold) and each fold.
    let sinceFold: string[] = []
    for (const event of trace.events) {
      if (event.startsWith('fold:')) {
        expect(sinceFold).toContain('yield')
        sinceFold = []
      } else {
        sinceFold.push(event)
      }
    }
    expect(trace.events.filter((event) => event.startsWith('fold:'))).toEqual([
      'fold:session-fold-1',
      'fold:session-fold-2'
    ])
  })
})
