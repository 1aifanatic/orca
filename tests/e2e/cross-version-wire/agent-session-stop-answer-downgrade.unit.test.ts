import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../src/shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../src/shared/agent-session-journal-item-key'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// A Stop's answer rides its note as an optional key (Rule 1). Whatever the newest release knows of
// it, that release's host must keep the note when it replays this build's journal, and its client
// must admit the note it is published and print its text. Both hold for every version, so the
// baseline rolls with each cut.
const JOURNAL = 'src/main/native-chat/agent-session-journal'
const NOTE_TEXT = 'Codex had no turn running to stop.'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-stop-answer',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
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
  state: { items: Map<string, { body: { text?: string } }> }
  corrupt: boolean
  malformedRows: number
  truncateFrom?: number
}

test("an older build keeps a Stop's note carrying its answer, folds the rows after it, and publishes it to a client that admits it", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-stop-answer-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    // This build: a Stop's event, its note with the answer, then more history.
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    await journal.appendStopEvent({ reason: 'user-stop', caller: 'client-1' }, 1)
    const before = journal.cursor()
    const eventAt = journal.stopMarks.latest()!.event.at
    const note = { provider: 'orca' as const, clientMessageId: 'stop:operation-1' }
    await journal.appendItem(
      note,
      { kind: 'status', text: NOTE_TEXT, stop: { answer: 'no-effect', eventAt } },
      scope
    )
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'status', text: 'after the Stop' },
      scope
    )
    const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const rows: JournalRow[] = since.rows
    const noteId = agentJournalItemKey(note)

    const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
    const [database, table, open, reducer, batch, schemas] = await Promise.all(
      [
        `${JOURNAL}/journal-database.ts`,
        `${JOURNAL}/journal-row-table.ts`,
        `${JOURNAL}/journal-open.ts`,
        `${JOURNAL}/journal-reducer.ts`,
        'src/main/native-chat/agent-session-wire/agent-session-journal-batch.ts',
        'src/shared/agent-session-journal-schemas.ts'
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
        batch?: { items: { itemId: string; body: { text?: string } }[] }
      }
    >(batch, 'projectJournalBatch')
    const isAdmissibleAgentJournalRenderItem = releaseExport<(value: unknown) => boolean>(
      schemas,
      'isAdmissibleAgentJournalRenderItem'
    )

    const { db } = openJournalDatabase(join(directory, 'older-build-journal.sqlite'))
    try {
      upsertJournalSessionRow(db, IDENTITY.sessionId, journal.epoch, 1)
      for (const row of rows) {
        insertJournalRow(db, IDENTITY.sessionId, row)
      }
      // Older host after a downgrade: no row is unknown or malformed, and the rows after it fold.
      const replayed = replayJournal(db, false, IDENTITY.sessionId)
      expect(replayed).toMatchObject({ corrupt: false, malformedRows: 0 })
      expect(replayed?.truncateFrom).toBeUndefined()
      expect(replayed?.state.items.get(noteId)?.body.text).toBe(NOTE_TEXT)
      expect(replayed?.state.items.size).toBe(2)

      // Older client against a host publishing the note: it admits the item and reads its text.
      const projected = projectJournalBatch({
        rows: rows.filter((row) => row.seq > before.sequence),
        snapshot: renderJournalState(replayed?.state),
        afterSequence: before.sequence
      })
      expect(projected.ok).toBe(true)
      const published = projected.batch?.items.find((item) => item.itemId === noteId)
      expect(published?.body.text).toBe(NOTE_TEXT)
      expect(isAdmissibleAgentJournalRenderItem(published)).toBe(true)
      const current = journal.snapshot().items.find((item) => item.itemId === noteId)
      expect(isAdmissibleAgentJournalRenderItem(current)).toBe(true)
    } finally {
      db.close()
    }
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)
