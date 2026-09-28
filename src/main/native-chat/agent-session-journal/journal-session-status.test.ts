// T-status: the saved listing status is keyed by the position it was computed at, so a reader can
// trust it only where the journal still stands exactly there — and never across an epoch change.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionStatusProjection } from '../../../shared/structured-agent-session-projection'
import type Database from '../../sqlite/sync-database'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { writeJournalSessionStatus } from './journal-session-status'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const IDLE: StructuredAgentSessionStatusProjection = {
  status: 'idle',
  latestPrompt: 'add a retry',
  lastAssistantMessage: 'Done.'
}

let root: string
const journals = createTrackedJournalOpener()

/** The one join a restarted host lists from: a saved status stands only at its own tip. */
function trustedStatuses(db: Database.Database): { session_id: string; status_json: string }[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the columns are named in the statement.
  return db
    .prepare(
      `SELECT s.session_id, s.status_json FROM journal_sessions s
       WHERE s.status_json IS NOT NULL AND s.block * 4294967296 + s.status_seq = (
         SELECT max(r.id) FROM journal_rows r
         WHERE r.id >= s.block * 4294967296 AND r.id < (s.block + 1) * 4294967296)`
    )
    .all() as { session_id: string; status_json: string }[]
}

async function settled(): Promise<void> {
  // The write joins the chat's queue behind the rows it describes.
  await new Promise<void>((resolve) => setImmediate(resolve))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-status-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the saved listing status', () => {
  it('is saved at the tip it was computed at, and trusted only there', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const { db } = openTestJournalHostDatabase(root)

    journal.saveListingStatus(IDLE)
    await settled()
    expect(trustedStatuses(db)).toHaveLength(1)
    expect(JSON.parse(trustedStatuses(db)[0]!.status_json)).toMatchObject({
      v: 1,
      projection: IDLE,
      lastActivityAt: journal.lastActivityAt()
    })

    // A row the status was not computed at: a miss, never a stale display.
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'note' },
      { kind: 'status', text: 'later' },
      { fence: 0 }
    )
    expect(trustedStatuses(db)).toEqual([])
  })

  it('is written once per change, not once per row', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const { db } = openTestJournalHostDatabase(root)
    const prepare = vi.spyOn(db, 'prepare')

    journal.saveListingStatus(IDLE)
    journal.saveListingStatus({ ...IDLE })
    await settled()

    expect(
      prepare.mock.calls.filter(([sql]) => sql.startsWith('UPDATE journal_sessions'))
    ).toHaveLength(1)
  })

  // The epoch case: a new epoch clears the saved status, and a write computed before the change
  // cannot land on the new epoch even where its sequence matches the new tip.
  it('never survives an epoch change, whatever the old position says', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const { db } = openTestJournalHostDatabase(root)
    journal.saveListingStatus(IDLE)
    await settled()
    const before = journal.cursor()

    await journal.rollEpoch('handle_forked', 1)
    expect(journal.cursor().sequence).toBe(before.sequence)
    expect(trustedStatuses(db)).toEqual([])

    writeJournalSessionStatus(db, IDENTITY.sessionId, before, JSON.stringify({ stale: true }))
    expect(trustedStatuses(db)).toEqual([])
  })
})
