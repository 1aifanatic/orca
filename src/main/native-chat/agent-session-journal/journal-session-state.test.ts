// Each chat's stored status: written in the same transaction as every journal write, equal to what a
// fresh replay derives, for every chat state; a failed write leaves the fold equal to the disk.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalPragmaNumber } from './journal-database'
import {
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  loadTestJournal,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import * as JournalOpen from './journal-open'
import { renderJournalState } from './journal-reducer'
import {
  deriveJournalSessionStatus,
  isUnsettledJournalSessionStatus,
  readUnsettledJournalSessionIds,
  type JournalSessionStatus
} from './journal-session-state'
import {
  CORPUS_UNSETTLED,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS,
  type JournalSessionStateCase
} from './journal-session-state-test-corpus'
import type { AgentSessionJournal } from './journal-store'

vi.mock('./journal-open', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalOpen>()
  return { ...actual, replayJournal: vi.fn(actual.replayJournal) }
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
    mintEpoch: () => `epoch-${sessionId}-${clock}`
  })
}

function db() {
  return openTestJournalHostDatabase(root).db
}

/** What a fresh open of the chat would derive, read back from disk. */
function freshDerivation(sessionId: string): JournalSessionStatus {
  const loaded = loadTestJournal(root, sessionId)
  if (!loaded) {
    throw new Error(`no journal for ${sessionId}`)
  }
  return deriveJournalSessionStatus(loaded.state, { settlesRosters: !loaded.corrupt })
}

const stored = (sessionId: string) => readTestJournalSessionStatus(root, sessionId)

async function write(name: JournalSessionStateCase): Promise<AgentSessionJournal> {
  const journal = await open(name)
  await JOURNAL_SESSION_STATE_CORPUS[name](journal)
  return journal
}

function note(journal: AgentSessionJournal, id: string) {
  return journal.appendItem(
    { provider: 'orca', clientMessageId: id },
    { kind: 'status', text: id },
    { fence: 3, turnScope: { kind: 'thread' } }
  )
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

function refuseStatusWrites(): void {
  db().exec(`CREATE TEMP TRIGGER fail_status_write BEFORE UPDATE ON main.journal_session_state
    BEGIN SELECT RAISE(ABORT, 'status write refused'); END`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-session-state-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the stored status follows every write (T3)', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)('%s', async (name) => {
    const journal = await open(name)
    const mismatches: string[] = []
    // Told after each commit, which carried the row and its status together.
    journal.observeCommits(() => {
      const expected = freshDerivation(name)
      try {
        expect(stored(name)).toEqual(expected)
      } catch {
        mismatches.push(`seq ${journal.cursor().sequence}`)
      }
    })
    await JOURNAL_SESSION_STATE_CORPUS[name](journal)
    expect(mismatches).toEqual([])
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(isUnsettledJournalSessionStatus(stored(name)!)).toBe(CORPUS_UNSETTLED[name])
    expect(readUnsettledJournalSessionIds(db()).includes(name)).toBe(CORPUS_UNSETTLED[name])
  })
})

describe('a chat that opened corrupt stores what a fresh replay derives (T3)', () => {
  const name = 'working subagent roster'

  async function openCorrupt(): Promise<AgentSessionJournal> {
    const journal = await write(name)
    const tip = journal.cursor()
    await journal.close()
    // A bad write past the tip: the next open drops it and owes a rebuild from provider history.
    insertTestJournalRowJson(db(), name, tip.sequence + 1, '{"not a row"')
    const reopened = await open(name)
    expect(reopened.needsRebuild).toBe(true)
    // The repair wrote the status; rosters wait for the rebuild, as the settle does.
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(stored(name)).toMatchObject({ liveChildWork: false })
    return reopened
  }

  it('shows the roster again once the chat writes past the repair', async () => {
    const journal = await openCorrupt()
    await note(journal, 'note-1')
    expect(journal.needsRebuild).toBe(false)
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(stored(name)).toMatchObject({ liveChildWork: true })
  })

  it('shows the roster again once provider history rebuilds the chat', async () => {
    const journal = await openCorrupt()
    await journal.replaceEpochItems('legacy_import', 3, [
      {
        identity: { provider: 'orca', clientMessageId: 'roster-1' },
        body: {
          kind: 'message',
          role: 'system',
          blocks: [
            {
              type: 'subagent-group',
              groupId: 'group-1',
              agents: [{ id: 'child-1', label: 'reads', state: 'working', startedAt: 10 }]
            }
          ]
        }
      }
    ])
    expect(journal.needsRebuild).toBe(false)
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(stored(name)).toMatchObject({ liveChildWork: true })
  })
})

describe('a failed write leaves the fold equal to the disk (T1)', () => {
  it('folds nothing, stores nothing, and the next append takes the sequence, after a failed COMMIT', async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    const before = stored('settled')
    failNextCommit()

    await expect(note(journal, 'lost')).rejects.toThrow('COMMIT failed')

    expect(journal.cursor()).toEqual(tip)
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, 'settled')!.state))
    expect(stored('settled')).toEqual(before)
    await expect(note(journal, 'kept')).resolves.toMatchObject({
      cursor: { sequence: tip.sequence + 1 }
    })
    expect(stored('settled')).toEqual(freshDerivation('settled'))
  })

  it('fails the append when its status write fails: the row and its status land together or not at all', async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    refuseStatusWrites()

    await expect(note(journal, 'refused')).rejects.toThrow('status write refused')

    expect(loadTestJournal(root, 'settled')?.state.lastSequence).toBe(tip.sequence)
    expect(journal.cursor()).toEqual(tip)
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, 'settled')!.state))
    db().exec('DROP TRIGGER fail_status_write')
    await expect(note(journal, 'kept')).resolves.toMatchObject({
      cursor: { sequence: tip.sequence + 1 }
    })
  })

  it('never shows a held submission the change that rolled back', async () => {
    const journal = await open('held')
    await journal.appendSubmission({
      clientMessageId: 'send-1',
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 3
    })
    const held = journal.submission('send-1')!
    expect(held.dispatchState).toBe('pending')
    failNextCommit()

    await expect(
      journal.resolveDispatch({
        clientMessageId: 'send-1',
        state: 'rejected',
        reason: 'refused',
        fence: 3
      })
    ).rejects.toThrow('COMMIT failed')

    expect(held.dispatchState).toBe('pending')
    expect(journal.submission('send-1')).toMatchObject({ dispatchState: 'pending' })
  })

  it('re-reads a fold whose re-read failed before its next use, and keeps the chat open', async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(JournalOpen.replayJournal).mockImplementationOnce(() => {
      throw new Error('disk I/O error')
    })
    failNextCommit()

    await expect(note(journal, 'lost')).rejects.toThrow('COMMIT failed')

    // The next read re-reads the disk instead of serving the fold that held the lost row.
    expect(journal.cursor()).toEqual(tip)
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, 'settled')!.state))
    await expect(note(journal, 'kept')).resolves.toMatchObject({
      cursor: { sequence: tip.sequence + 1 }
    })
  })
})

describe('epoch writes carry the status (T10)', () => {
  it('writes it for a new epoch, a roll and a replacement, in their transactions', async () => {
    const journal = await open('epochs')
    expect(stored('epochs')).toMatchObject({ status: 'idle', summary: { status: null } })
    await JOURNAL_SESSION_STATE_CORPUS['running tool'](journal)
    expect(stored('epochs')).toMatchObject({ status: 'running' })

    await journal.rollEpoch('unreconcilable_prefix', 3)
    expect(stored('epochs')).toEqual(freshDerivation('epochs'))
    expect(stored('epochs')).toMatchObject({ status: 'idle' })

    await journal.replaceEpochItems('legacy_import', 3, [
      {
        identity: { provider: 'orca', clientMessageId: 'rebuilt-1' },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'rebuilt' }] }
      }
    ])
    expect(stored('epochs')).toEqual(freshDerivation('epochs'))
  })

  it('fails a roll whose status write fails, leaving the epoch where it was', async () => {
    const journal = await write('settled')
    const epoch = journal.epoch
    refuseStatusWrites()

    await expect(journal.rollEpoch('handle_forked', 3)).rejects.toThrow('status write refused')

    expect(journal.epoch).toBe(epoch)
    expect(loadTestJournal(root, 'settled')?.state.epoch).toBe(epoch)
  })

  it('arrives with schema version 5', async () => {
    await write('settled')
    expect(JOURNAL_DB_SCHEMA_VERSION).toBe(5)
    expect(journalPragmaNumber(db(), 'user_version')).toBe(5)
  })
})

describe('a stored summary is fence-independent once settled (T15a, regression guard)', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)('%s', async (name) => {
    await write(name)
    const derived = freshDerivation(name)
    if (isUnsettledJournalSessionStatus(derived)) {
      return
    }
    const snapshot = renderJournalState(loadTestJournal(root, name)!.state)
    for (const fence of [undefined, 0, 3, 4, 100]) {
      expect(
        projectStructuredAgentSessionStatusState(snapshot.items, snapshot.submissions, fence)
          .summary
      ).toEqual(derived.summary)
    }
  })
})
