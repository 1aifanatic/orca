// The host says why it keeps a chat read-only on every whole page it serves, so a client can lock
// its composer before a send is refused: a hydration page, a history page, and a catch-up's reset
// alike.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { agentSessionReadOnlyNoticeParts } from '../../../shared/agent-session-read-only'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { JOURNAL_DB_SCHEMA_VERSION } from '../agent-session-journal/journal-database-schema'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from './agent-session-history-page'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-read-only-page',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-read-only-page-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function open(): Promise<AgentSessionJournal> {
  return journals.open({ identity: IDENTITY, stateDirectory: root })
}

/** A chat of `texts`, reopened after a newer build appended `row` at the next sequence. */
async function reopenedAfter(row: (epoch: string) => Record<string, unknown>, texts = ['before']) {
  const journal = await open()
  for (const [ordinal, text] of texts.entries()) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
      { kind: 'status', text },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  const seq = journal.cursor().sequence + 1
  const epoch = journal.epoch
  await journals.closeAll()
  const json = JSON.stringify({ ...row(epoch), epoch, seq, fence: 1, ts: 5_000 })
  insertTestJournalRowJson(
    openTestJournalHostDatabase(root).db,
    IDENTITY.sessionId,
    seq,
    json,
    5_000
  )
  closeTestJournalHostDatabase(root)
  return open()
}

/** Every whole page this host serves for the chat, as a client would ask for it. */
function servedPages(journal: AgentSessionJournal) {
  const tail = readAgentSessionHistory(journal, {
    sessionId: IDENTITY.sessionId,
    direction: 'tail'
  })
  const after = readAgentSessionHistory(journal, {
    sessionId: IDENTITY.sessionId,
    direction: 'after',
    cursor: { epoch: journal.epoch, sequence: 0 }
  })
  return [readAgentSessionHydrationPage(journal, 1), tail.page, after.page]
}

/** What a client attaching to the chat would say, desktop and phone alike: the hydration page as a
 *  snapshot through the shared client reducer, in the phone's English. */
function attachedClientNotice(journal: AgentSessionJournal): string | null {
  const state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: {
      type: 'snapshot',
      sessionId: IDENTITY.sessionId,
      page: readAgentSessionHydrationPage(journal, 1),
      fence: 1
    }
  })
  const parts = agentSessionReadOnlyNoticeParts(state.readOnly)
  return parts ? agentSessionWriteNoticeEnglish(parts) : null
}

const NOTICE = 'Saved by a newer Orca. Update Orca to continue this chat.'

const ITEM = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, kind: 'item', itemId: 'x', revision: 1 }

describe('a chat the host keeps read-only', () => {
  it.each([
    ['a newer row version', () => ({ ...ITEM, v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1 })],
    ['a newer row kind', () => ({ v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, kind: 'future-mark' })],
    [
      'a newer batch-change kind',
      () => ({
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        kind: 'lifecycle-batch',
        settlementId: 'settle-1',
        mutations: [{ kind: 'pin', itemId: 'x', revision: 1 }]
      })
    ]
  ])('names a newer Orca on every page, for %s', async (_cause, row) => {
    const journal = await reopenedAfter(row)
    expect(journal.isReadOnly).toBe(true)
    for (const page of servedPages(journal)) {
      expect(page.readOnly).toBe('written-by-newer-orca')
    }
    expect(attachedClientNotice(journal)).toBe(NOTICE)
  })

  it('names a newer Orca on every page when a newer build stamped the whole database', async () => {
    const journal = await reopenedAfter(() => ({
      ...ITEM,
      body: { kind: 'status', text: 'later' }
    }))
    expect(journal.isReadOnly).toBe(false)
    await journals.closeAll()
    const opened = openTestJournalHostDatabase(root)
    opened.db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
    closeTestJournalHostDatabase(root)
    const newer = await open()
    expect(newer.isReadOnly).toBe(true)
    for (const page of servedPages(newer)) {
      expect(page.readOnly).toBe('written-by-newer-orca')
    }
    expect(attachedClientNotice(newer)).toBe(NOTICE)
  })
})

it('pages back through a read-only chat; only a forward read of its rows resets', async () => {
  const journal = await reopenedAfter(
    () => ({ v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, kind: 'future-mark' }),
    ['first', 'second']
  )
  expect(journal.isReadOnly).toBe(true)
  const request = { sessionId: IDENTITY.sessionId, limit: 1 }
  const tail = readAgentSessionHistory(journal, { ...request, direction: 'tail' })
  expect(tail).toMatchObject({ ok: true, page: { hasOlder: true } })
  const older = readAgentSessionHistory(journal, {
    ...request,
    direction: 'before',
    cursor: tail.page.window.nextCursor
  })
  expect(older).toMatchObject({ ok: true, page: { readOnly: 'written-by-newer-orca' } })
  expect(older.page.items.map((item) => item.body)).toEqual([{ kind: 'status', text: 'first' }])
  const after = readAgentSessionHistory(journal, {
    ...request,
    direction: 'after',
    cursor: { epoch: journal.epoch, sequence: 0 }
  })
  expect(after).toMatchObject({ ok: false, reset: 'schema_unreadable' })
})

it('says nothing on a chat that takes writes', async () => {
  const journal = await reopenedAfter(() => ({ ...ITEM, body: { kind: 'status', text: 'later' } }))
  expect(journal.isReadOnly).toBe(false)
  for (const page of servedPages(journal)) {
    expect(page).not.toHaveProperty('readOnly')
  }
  expect(attachedClientNotice(journal)).toBeNull()
})
