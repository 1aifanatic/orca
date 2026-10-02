import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentSessionJournalIdentity
} from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { agentSessionReadOnlyNoticeParts } from '../../../src/shared/agent-session-read-only'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../src/shared/structured-agent-session-reducer'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from '../../../src/main/native-chat/agent-session-wire/agent-session-history-page'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * A host that keeps a chat read-only now says why on every whole page (`page.readOnly`), and this
 * build keeps a body of a kind it does not know (or a plan subject of one), writable, instead of
 * deleting from it. Both meet builds that predate them: an older client is sent the new field
 * (Rule 1), and an older host opens a journal holding such a body.
 */
const SUITE_TIMEOUT_MS = 180_000
// A main build that shares this one's host database and schema version, so a downgrade to it opens
// the journal writable. No release tag has that database yet; move to the first one that does.
const WRITABLE_BASELINE_REF = '3727100cc9dbcea6201f8a3e506676a3c4b53b18'
const JOURNAL = 'src/main/native-chat/agent-session-journal'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-read-only',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

type Reduce = (state: unknown, action: unknown, receivedAt?: number) => unknown

let directory: string
const journals = createTrackedJournalOpener()

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-read-only-xv-'))
})

afterAll(async () => {
  await journals.closeAll()
  rmSync(directory, { recursive: true, force: true })
})

/** A function the checked-out build exports, typed as the caller calls it. */
function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the checked-out build exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an export the checked-out build defines; each caller names the shape it uses, and a changed one fails the test.
  return value as T
}

const NEWER_BODY_KIND = { kind: 'plan-card', steps: [{ text: 'by a newer build' }] }
const NEWER_NESTED_LITERAL = {
  kind: 'approval',
  title: 'Approve the change?',
  detail: null,
  options: [{ id: 'yes', label: 'Yes' }],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null },
  subject: { kind: 'diff', path: 'a.ts' }
}

/** A row of a kind this build does not know: the journal opens read-only. */
const NEWER_ROW_KIND = { kind: 'future-mark' }

/** This build's journal of two items, then a row as a newer build wrote it: an item holding
 *  `body`, or `row` itself: closed. */
async function journalWithNewerRow(
  row: Record<string, unknown> = NEWER_ROW_KIND
): Promise<{ rows: string[]; newer: string }> {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
    { kind: 'status', text: 'before' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 2 },
    { kind: 'status', text: 'also before' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const seq = journal.cursor().sequence + 1
  const newer = JSON.stringify({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: journal.epoch,
    seq,
    fence: 1,
    ts: 2_000,
    ...row
  })
  await journals.closeAll()
  insertTestJournalRowJson(
    openTestJournalHostDatabase(directory).db,
    IDENTITY.sessionId,
    seq,
    newer,
    2_000
  )
  return { rows: storedRows(), newer }
}

function storedRows(): string[] {
  const rows = liveTestJournalRows(openTestJournalHostDatabase(directory).db, IDENTITY.sessionId)
  closeTestJournalHostDatabase(directory)
  return rows.map((row) => row.rowJson)
}

function frames(page: AgentSessionHistoryPage): AgentSessionSubscribeEvent[] {
  return [
    { type: 'snapshot', sessionId: IDENTITY.sessionId, page, fence: 1 },
    { type: 'reset', sessionId: IDENTITY.sessionId, reset: 'schema_unreadable', page, fence: 1 }
  ]
}

describe('a chat a newer Orca saved, across versions', () => {
  it(
    'old client against new host: the read-only page reduces exactly as the same page without the field',
    async () => {
      await journalWithNewerRow()
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
      expect(journal.isReadOnly).toBe(true)
      const page = readAgentSessionHydrationPage(journal, 1)
      // The payload under test carries the field, or this compares nothing.
      expect(page.readOnly).toBe('written-by-newer-orca')
      const { readOnly: _field, ...withoutField } = page
      await journals.closeAll()

      const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
      const reducer = await importReleaseCheckoutModule(
        checkout,
        'src/shared/structured-agent-session-reducer.ts'
      )
      const reduce = releaseExport<Reduce>(reducer, 'reduceStructuredAgentSession')
      const empty = releaseExport<unknown>(reducer, 'EMPTY_STRUCTURED_AGENT_SESSION')
      for (const [index, frame] of frames(page).entries()) {
        const reference = frames(withoutField)[index]
        expect(reduce(empty, { type: 'event', event: frame }, 1), frame.type).toEqual(
          reduce(empty, { type: 'event', event: reference }, 1)
        )
      }
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'old client against new host: it hydrates a read-only chat and scrolls back through it as through a writable one',
    async () => {
      rmSync(directory, { recursive: true, force: true })
      directory = mkdtempSync(join(tmpdir(), 'orca-read-only-xv-'))
      await journalWithNewerRow()
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
      expect(journal.isReadOnly).toBe(true)
      const request = { sessionId: IDENTITY.sessionId, limit: 1 }
      const tail = readAgentSessionHistory(journal, { ...request, direction: 'tail' })
      const requestedCursor = tail.page.window.nextCursor
      const older = readAgentSessionHistory(journal, {
        ...request,
        direction: 'before',
        cursor: requestedCursor
      })
      await journals.closeAll()
      // Both are pages, not resets, and carry the field, or this compares nothing.
      expect([tail.ok, older.ok, tail.page.readOnly, older.page.readOnly]).toEqual([
        true,
        true,
        'written-by-newer-orca',
        'written-by-newer-orca'
      ])
      const { readOnly: _tailField, ...tailWithout } = tail.page
      const { readOnly: _olderField, ...olderWithout } = older.page

      const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
      const reducer = await importReleaseCheckoutModule(
        checkout,
        'src/shared/structured-agent-session-reducer.ts'
      )
      const reduce = releaseExport<Reduce>(reducer, 'reduceStructuredAgentSession')
      const empty = releaseExport<unknown>(reducer, 'EMPTY_STRUCTURED_AGENT_SESSION')
      const scrolledBack = (first: AgentSessionHistoryPage, next: AgentSessionHistoryPage) =>
        reduce(
          reduce(empty, { type: 'history-page', page: first }, 1),
          { type: 'older-page', requestedCursor, page: next },
          1
        )
      const state = scrolledBack(tail.page, older.page)
      expect(state).toEqual(scrolledBack(tailWithout, olderWithout))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the released reducer's state keeps its loaded items under `items`, as every release has.
      const items = (state as { items: { body: unknown }[] }).items.map((item) => item.body)
      expect(items).toEqual([
        { kind: 'status', text: 'before' },
        { kind: 'status', text: 'also before' }
      ])
    },
    SUITE_TIMEOUT_MS
  )

  it('new client against old host: a page with no field says nothing', () => {
    const page: AgentSessionHistoryPage = {
      sessionId: IDENTITY.sessionId,
      epoch: 'epoch-1',
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
      hasOlder: false,
      hasNewer: false
    }
    for (const frame of frames(page)) {
      const state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
        type: 'event',
        event: frame
      })
      expect(agentSessionReadOnlyNoticeParts(state.readOnly), frame.type).toBeNull()
    }
  })

  // Why a new body kind ships its reader first, or rides a bumped `v`: this build keeps one and
  // stays writable, but a build from before deletes the journal from it. Move the pinned build to
  // the first release with this rule, and the older build keeps the row too.
  it.each([
    ['body kind', NEWER_BODY_KIND],
    ['plan subject kind', NEWER_NESTED_LITERAL]
  ])(
    "this build keeps a newer build's %s and stays writable; a build before it deletes it",
    async (_value, body) => {
      rmSync(directory, { recursive: true, force: true })
      directory = mkdtempSync(join(tmpdir(), 'orca-read-only-xv-'))
      const { rows, newer } = await journalWithNewerRow({
        kind: 'item',
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body
      })
      const reopened = await journals.open({ identity: IDENTITY, stateDirectory: directory })
      expect(reopened.isReadOnly).toBe(false)
      await journals.closeAll()
      expect(storedRows()).toEqual(rows)

      const checkout = await materializeReleaseCheckout(WRITABLE_BASELINE_REF)
      const support = await importReleaseCheckoutModule(
        checkout,
        `${JOURNAL}/journal-host-database-test-support.ts`
      )
      const older = releaseExport<
        () => {
          open: (options: {
            identity: AgentSessionJournalIdentity
            stateDirectory: string
          }) => Promise<unknown>
          closeAll: () => Promise<void>
        }
      >(support, 'createTrackedJournalOpener')()
      try {
        await older.open({ identity: IDENTITY, stateDirectory: directory })
      } finally {
        await older.closeAll()
      }
      expect(storedRows()).not.toContain(newer)
    },
    SUITE_TIMEOUT_MS
  )
})
