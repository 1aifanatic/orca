import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../src/shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A release that knows neither the Stop event nor the Resume marker: an unknown row kind would
// make it delete the journal from that row on, so both ride a tombstone it already reads.
const BASELINE_REF = 'v1.4.218'
const JOURNAL = 'src/main/native-chat/agent-session-journal'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-downgrade',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

/** A function the pinned release exports, typed as the caller calls it. */
function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`the pinned release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a function the pinned release exports; each caller names the signature it calls, and a changed one fails the test.
  return value as T
}

type OldReplay = {
  state: { items: Map<string, unknown> }
  readOnly: boolean
  corrupt: boolean
  malformedRows: number
  truncateFrom?: number
}

test("an older build keeps every row around a Stop's event and a Resume, and folds the rows after them", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-stop-event-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    // This build: history, a person's Stop, a Resume, then more history.
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    const append = (ordinal: number, text: string) =>
      journal.appendItem(
        item(ordinal),
        { kind: 'status', text },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await append(0, 'before the Stop')
    const beforeMarks = journal.cursor()
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1', caller: 'client-1' }, 1)
    await journal.appendQueueResume(1)
    const afterMarks = journal.cursor()
    await append(1, 'after the Stop')
    const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const rows: JournalRow[] = since.rows

    // The older build, after a downgrade, replays the same rows from its own database.
    const checkout = await materializeReleaseCheckout(BASELINE_REF)
    const [database, table, open, reducer, batch] = await Promise.all(
      [
        `${JOURNAL}/journal-database.ts`,
        `${JOURNAL}/journal-row-table.ts`,
        `${JOURNAL}/journal-open.ts`,
        `${JOURNAL}/journal-reducer.ts`,
        'src/main/native-chat/agent-session-wire/agent-session-journal-batch.ts'
      ].map((path) => importReleaseCheckoutModule(checkout, path))
    )
    const openJournalDatabase = releaseExport<(path: string) => { db: { close: () => void } }>(
      database,
      'openJournalDatabase'
    )
    const upsertJournalSessionRow = releaseExport<
      (...args: [unknown, string, string, number]) => void
    >(table, 'upsertJournalSessionRow')
    const insertJournalRow = releaseExport<(...args: [unknown, string, JournalRow]) => void>(
      table,
      'insertJournalRow'
    )
    const replayJournal = releaseExport<(...args: [unknown, boolean, string]) => OldReplay | null>(
      open,
      'replayJournal'
    )
    const renderJournalState = releaseExport<(state: unknown) => unknown>(
      reducer,
      'renderJournalState'
    )
    const projectJournalBatch = releaseExport<
      (input: { rows: readonly JournalRow[]; snapshot: unknown; afterSequence: number }) => {
        ok: boolean
        batch?: { items: unknown[]; removedItemIds: string[] }
      }
    >(batch, 'projectJournalBatch')

    const { db } = openJournalDatabase(join(directory, 'older-build-journal.sqlite'))
    try {
      upsertJournalSessionRow(db, IDENTITY.sessionId, journal.epoch, 1)
      for (const row of rows) {
        insertJournalRow(db, IDENTITY.sessionId, row)
      }
      const replayed = replayJournal(db, false, IDENTITY.sessionId)
      expect(replayed).toMatchObject({ readOnly: false, corrupt: false, malformedRows: 0 })
      expect(replayed?.truncateFrom).toBeUndefined()
      expect([...(replayed?.state.items.keys() ?? [])]).toHaveLength(2)

      // An older client is sent only ids no item uses, removed.
      const projected = projectJournalBatch({
        rows: rows.filter(
          (row) => row.seq > beforeMarks.sequence && row.seq <= afterMarks.sequence
        ),
        snapshot: renderJournalState(replayed?.state),
        afterSequence: beforeMarks.sequence
      })
      expect(projected.ok).toBe(true)
      expect(projected.batch?.items).toEqual([])
      expect(projected.batch?.removedItemIds).toHaveLength(2)
      const liveIds = new Set(journal.snapshot().items.map((entry) => entry.itemId))
      expect(projected.batch?.removedItemIds.some((id) => liveIds.has(id))).toBe(false)
    } finally {
      db.close()
    }
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})
