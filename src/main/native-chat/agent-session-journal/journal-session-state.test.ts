// Each chat's stored state: written right after each journal commit, equal to what a fresh replay
// derives, never able to fail the write it describes, and trusted only at the chat's live tip.

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalPragmaNumber } from './journal-database'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  insertTestJournalRowJson,
  loadTestJournal,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { renderJournalState } from './journal-reducer'
import { deleteJournalRepairedSuffix } from './journal-repair-marker'
import {
  deriveJournalSessionState,
  JOURNAL_SESSION_STATE_VERSION,
  readJournalSessionState,
  readJournalSessionStatesAtTip,
  type DerivedJournalSessionState
} from './journal-session-state'
import {
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS,
  type JournalSessionStateCase
} from './journal-session-state-test-corpus'
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
function freshDerivation(sessionId: string): DerivedJournalSessionState {
  const loaded = loadTestJournal(root, sessionId)
  if (!loaded) {
    throw new Error(`no journal for ${sessionId}`)
  }
  return deriveJournalSessionState(loaded.state, { settlesRosters: !loaded.corrupt })
}

function stored(sessionId: string) {
  const row = readJournalSessionState(db(), sessionId)
  if (!row) {
    return null
  }
  const { stateVersion: _stateVersion, writtenAt: _writtenAt, ...derived } = row
  return derived
}

async function write(name: JournalSessionStateCase): Promise<AgentSessionJournal> {
  const journal = await open(name)
  await JOURNAL_SESSION_STATE_CORPUS[name](journal)
  return journal
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

describe('the stored state follows every append (T3)', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)('%s', async (name) => {
    const journal = await open(name)
    const mismatches: string[] = []
    // Observers hear of a commit first; its state lands in the same task, before the next write.
    journal.observeCommits(() => {
      queueMicrotask(() => {
        const expected = freshDerivation(name)
        if (!isDeepStrictEqual(stored(name), expected)) {
          mismatches.push(`seq ${expected.seq}`)
        }
      })
    })
    await JOURNAL_SESSION_STATE_CORPUS[name](journal)
    await Promise.resolve()
    expect(mismatches).toEqual([])
    expect(stored(name)).toEqual(freshDerivation(name))
  })
})

function refuseStateWrites(): void {
  db().exec(`CREATE TEMP TRIGGER fail_state_write BEFORE UPDATE ON main.journal_session_state
    BEGIN SELECT RAISE(ABORT, 'state write refused'); END`)
}

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
    // Rosters wait for the rebuild, as the open's plan does.
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(stored(name)).toMatchObject({ owesWork: false })
    return reopened
  }

  it('owes the roster again once the chat writes past the repair', async () => {
    const journal = await openCorrupt()
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'note-1' },
      { kind: 'status', text: 'a note' },
      { fence: 3, turnScope: { kind: 'thread' } }
    )
    expect(journal.needsRebuild).toBe(false)
    expect(stored(name)).toEqual(freshDerivation(name))
    expect(stored(name)).toMatchObject({ owesWork: true })
  })

  it('owes the roster again once provider history rebuilds the chat', async () => {
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
    expect(stored(name)).toMatchObject({ owesWork: true })
  })
})

describe('a failing state write never fails the append (T2)', () => {
  it('commits the row, leaves the state behind the tip, and the next open re-derives it', async () => {
    const journal = await write('settled')
    const before = stored('settled')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    refuseStateWrites()

    await expect(
      journal.appendItem(
        { provider: 'orca', clientMessageId: 'note-1' },
        { kind: 'status', text: 'a note' },
        { fence: 3, turnScope: { kind: 'thread' } }
      )
    ).resolves.toMatchObject({ cursor: { sequence: before!.seq + 1 } })

    expect(loadTestJournal(root, 'settled')?.state.lastSequence).toBe(before!.seq + 1)
    expect(stored('settled')).toEqual(before)
    expect(readJournalSessionStatesAtTip(db(), ['settled'])).toEqual([
      { sessionId: 'settled', current: null }
    ])
    expect(warn).toHaveBeenCalledWith(
      '[agent-session-journal] storing the chat state failed',
      expect.objectContaining({ sessionId: 'settled', error: 'state write refused' })
    )

    db().exec('DROP TRIGGER fail_state_write')
    await journal.close()
    const reopened = await open('settled')
    reopened.ensureSessionState()
    expect(stored('settled')).toEqual(freshDerivation('settled'))
    expect(readJournalSessionStatesAtTip(db(), ['settled'])[0]?.current).not.toBeNull()
  })
})

describe('a failed COMMIT leaves the fold equal to the disk (T1)', () => {
  function note(journal: AgentSessionJournal, id: string) {
    return journal.appendItem(
      { provider: 'orca', clientMessageId: id },
      { kind: 'status', text: id },
      { fence: 3, turnScope: { kind: 'thread' } }
    )
  }

  it('folds nothing, stores nothing, and the next append takes the sequence', async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    const before = stored('settled')
    const connection = db()
    const exec = connection.exec.bind(connection)
    let failCommit = true
    vi.spyOn(connection, 'exec').mockImplementation((sql: string) => {
      if (failCommit && sql === 'COMMIT') {
        failCommit = false
        throw new Error('COMMIT failed: disk I/O error')
      }
      return exec(sql)
    })

    await expect(note(journal, 'lost')).rejects.toThrow('COMMIT failed')

    expect(journal.cursor()).toEqual(tip)
    expect(journal.snapshot()).toEqual(renderJournalState(loadTestJournal(root, 'settled')!.state))
    expect(stored('settled')).toEqual(before)
    await expect(note(journal, 'kept')).resolves.toMatchObject({
      cursor: { sequence: tip.sequence + 1 }
    })
    expect(stored('settled')).toEqual(freshDerivation('settled'))
  })
})

describe('trusted only at the live tip (T9)', () => {
  it('leaves the schema version alone, so an older build stays writable', async () => {
    await write('settled')
    expect(journalPragmaNumber(db(), 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
  })

  it("reads an older build's append as stale, and the next open re-derives it", async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    await journal.close()
    // What an older build's append leaves: the row, and no state beside it.
    insertTestJournalRow(db(), 'settled', {
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      kind: 'item',
      itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'older-build-note' }),
      revision: 1,
      body: { kind: 'status', text: 'from an older build' },
      epoch: tip.epoch,
      seq: tip.sequence + 1,
      fence: 3,
      ts: 5_000
    })
    expect(readJournalSessionStatesAtTip(db(), ['settled'])[0]?.current).toBeNull()

    const reopened = await open('settled')
    reopened.ensureSessionState()
    expect(readJournalSessionStatesAtTip(db(), ['settled'])[0]?.current).toMatchObject({
      seq: tip.sequence + 1,
      lastActivityAt: 5_000
    })
  })

  it("reads an older build's repair back to the same sequence as stale", async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    const row = readJournalSessionState(db(), 'settled')!
    // An older build repaired the chat after this row was written, then appended back to `seq`.
    db()
      .prepare(
        'INSERT INTO journal_repairs (session_id, epoch, content_from, repaired_at) VALUES (?, ?, ?, ?)'
      )
      .run('settled', tip.epoch, tip.sequence, row.writtenAt + 1)
    expect(readJournalSessionStatesAtTip(db(), ['settled'])[0]?.current).toBeNull()

    journal.ensureSessionState()
    expect(readJournalSessionStatesAtTip(db(), ['settled'])[0]?.current).not.toBeNull()
  })
})

describe('the epoch and history transactions keep it (T10)', () => {
  it('writes it for a new epoch, a roll and a replacement, after their transactions', async () => {
    const journal = await open('epochs')
    expect(stored('epochs')).toMatchObject({
      epoch: journal.epoch,
      seq: 1,
      owesWork: false,
      summary: { status: null, latestPrompt: '' }
    })
    await JOURNAL_SESSION_STATE_CORPUS['running tool'](journal)
    expect(stored('epochs')).toMatchObject({ owesWork: true, summary: null })

    await journal.rollEpoch('unreconcilable_prefix', 3)
    expect(stored('epochs')).toEqual(freshDerivation('epochs'))
    expect(stored('epochs')).toMatchObject({ epoch: journal.epoch, seq: 1, owesWork: false })

    await journal.replaceEpochItems('legacy_import', 3, [
      {
        identity: { provider: 'orca', clientMessageId: 'rebuilt-1' },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'rebuilt' }] }
      }
    ])
    expect(stored('epochs')).toEqual(freshDerivation('epochs'))
    expect(stored('epochs')).toMatchObject({ epoch: journal.epoch, seq: 2 })
  })

  it('never fails a roll or a replacement when the state write fails (R1J-2)', async () => {
    const journal = await write('settled')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    refuseStateWrites()

    await expect(journal.rollEpoch('handle_forked', 3)).resolves.toMatchObject({ sequence: 1 })
    expect(loadTestJournal(root, 'settled')?.state.epoch).toBe(journal.epoch)
    await expect(
      journal.replaceEpochItems('handle_forked', 3, [
        {
          identity: { provider: 'orca', clientMessageId: 'rebuilt-1' },
          body: { kind: 'status', text: 'rebuilt' }
        }
      ])
    ).resolves.toMatchObject({ sequence: 2 })
    expect(loadTestJournal(root, 'settled')?.state.epoch).toBe(journal.epoch)
    expect(readJournalSessionStatesAtTip(db(), ['settled'])[0]?.current).toBeNull()
  })

  it('drops it with a repair, and the next open writes it again', async () => {
    const journal = await write('settled')
    const tip = journal.cursor()
    await journal.close()
    deleteJournalRepairedSuffix({
      database: openTestJournalHostDatabase(root),
      sessionId: 'settled',
      epoch: tip.epoch,
      fromSeq: tip.sequence,
      contentFrom: tip.sequence,
      now: clock + 1
    })
    expect(readJournalSessionState(db(), 'settled')).toBeNull()

    const reopened = await open('settled')
    reopened.ensureSessionState()
    expect(stored('settled')).toEqual(freshDerivation('settled'))
  })
})

describe('the derivation is versioned (T11)', () => {
  // Pinned with the version: a change to what a row holds must bump the version, so rows an
  // earlier derivation wrote read as absent and are derived again.
  const GOLDEN = {
    version: 2,
    digest: '33a151ec037c24cbd1bd74cfaacc0bea419d132e1c4878724e416294635bba9b'
  }

  it('matches the digest pinned beside its version', async () => {
    const derived: Record<string, unknown> = {}
    for (const name of JOURNAL_SESSION_STATE_CASES) {
      await write(name)
      const { epoch: _epoch, ...row } = freshDerivation(name)
      derived[name] = row
    }
    const digest = createHash('sha256').update(JSON.stringify(derived)).digest('hex')
    expect({ version: JOURNAL_SESSION_STATE_VERSION, digest }).toEqual(GOLDEN)
  })

  it('reads a row of another version as absent', async () => {
    await write('settled')
    db().prepare('UPDATE journal_session_state SET state_version = 99').run()
    expect(readJournalSessionState(db(), 'settled')).toBeNull()
    expect(readJournalSessionStatesAtTip(db(), ['settled'])).toEqual([
      { sessionId: 'settled', current: null }
    ])
  })
})

describe('a stored summary is fence-independent (T15a, regression guard)', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)('%s', async (name) => {
    await write(name)
    const derived = freshDerivation(name)
    if (derived.owesWork) {
      expect(derived.summary).toBeNull()
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
