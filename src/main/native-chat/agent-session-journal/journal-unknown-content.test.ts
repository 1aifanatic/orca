// Inside a row of a known kind, what this build cannot read is never repaired away unless it is
// damage: a body or mutation of a newer kind, or a must-understand fact it cannot parse, latches
// the chat read-only with every row kept as it was; an annotation it cannot parse costs only that
// annotation. A required field that fails is still damage, repaired as before.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-newer-content',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-newer-content-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function open() {
  return journals.open({ identity: IDENTITY, stateDirectory: root })
}

function stored(): { seq: number; rowJson: string }[] {
  return liveTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId).map(
    (row) => ({ seq: row.seq, rowJson: row.rowJson })
  )
}

/** An anchor, two items, then `rows` as a newer build (or damage) wrote them, then one more item
 *  of this build's: closed, so the next open replays all of it. */
async function journalWith(rows: (epoch: string) => Record<string, unknown>[]) {
  const first = await open()
  await first.appendItem(item(0), { kind: 'status', text: 'one' }, SCOPE)
  await first.appendItem(item(1), { kind: 'status', text: 'two' }, SCOPE)
  const epoch = first.epoch
  let seq = first.cursor().sequence
  await journals.closeAll()
  const tail = itemRow(epoch, 'codex:thread-1:turn-1:9', { kind: 'status', text: 'after' })
  const { db } = openTestJournalHostDatabase(root)
  for (const row of [...rows(epoch), tail]) {
    seq += 1
    insertTestJournalRowJson(db, IDENTITY.sessionId, seq, JSON.stringify({ ...row, seq }), 5_000)
  }
  closeTestJournalHostDatabase(root)
  return { written: stored() }
}

function itemRow(epoch: string, itemId: string, body: Record<string, unknown>) {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch,
    fence: 1,
    ts: 5_000,
    kind: 'item',
    itemId,
    revision: 1,
    body
  }
}

const NEWER_BODY = { kind: 'plan-card', steps: [{ text: 'by a newer build' }] }

async function expectReadOnlyAndKept(written: { seq: number; rowJson: string }[]) {
  const journal = await open()
  expect(journal.isReadOnly).toBe(true)
  expect(journal.repair).toEqual({ malformedRows: 0 })
  await expect(
    journal.appendItem(item(5), { kind: 'status', text: 'refused' }, SCOPE)
  ).rejects.toMatchObject({ code: 'journal_read_only' })
  await journals.closeAll()
  expect(stored()).toEqual(written)
  const reopened = await open()
  expect(reopened.isReadOnly).toBe(true)
  await journals.closeAll()
  expect(stored()).toEqual(written)
}

describe("a newer build's content inside a known row", () => {
  it('latches read-only on an item body of a newer kind, with every row byte-identical', async () => {
    const { written } = await journalWith((epoch) => [
      itemRow(epoch, 'codex:thread-1:turn-1:2', NEWER_BODY)
    ])
    await expectReadOnlyAndKept(written)
  })

  it.each([
    ['of a newer kind', { kind: 'pin', itemId: 'codex:thread-1:turn-1:3', revision: 2 }],
    [
      'whose body is a newer kind',
      { kind: 'item', itemId: 'codex:thread-1:turn-1:4', revision: 1, body: NEWER_BODY }
    ]
  ])('latches read-only on a lifecycle mutation %s', async (_name, mutation) => {
    const { written } = await journalWith((epoch) => [
      {
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch,
        fence: 1,
        ts: 5_000,
        kind: 'lifecycle-batch',
        settlementId: 'settle-1',
        mutations: [
          {
            kind: 'item',
            itemId: 'codex:thread-1:turn-1:3',
            revision: 1,
            body: { kind: 'status', text: 'ok' }
          },
          mutation
        ]
      }
    ])
    await expectReadOnlyAndKept(written)
  })

  it('latches read-only on a submission whose body is a newer kind', async () => {
    const { written } = await journalWith((epoch) => [
      {
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch,
        fence: 1,
        ts: 5_000,
        kind: 'submission',
        clientMessageId: 'client-1',
        payloadFingerprint: 'f',
        providerHandle: IDENTITY.providerHandle,
        body: { kind: 'voice-note', clip: 'by a newer build' }
      }
    ])
    await expectReadOnlyAndKept(written)
  })

  it('latches read-only on a must-understand fact it cannot parse', async () => {
    const { written } = await journalWith((epoch) => [
      itemRow(epoch, 'codex:thread-1:turn-1:2', {
        kind: 'status',
        text: 'Turn started',
        turnLifecycle: { turnId: 7, state: 'running' }
      })
    ])
    await expectReadOnlyAndKept(written)
  })
})

describe('an annotation this build cannot parse', () => {
  it('costs only the annotation: the chat stays writable, nothing is deleted or rewritten', async () => {
    const { written } = await journalWith((epoch) => [
      itemRow(epoch, 'codex:thread-1:turn-1:2', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'done',
        durationMs: null,
        outcome: 3
      })
    ])
    const journal = await open()
    expect(journal.isReadOnly).toBe(false)
    expect(journal.repair).toEqual({ malformedRows: 0 })
    const items = journal.snapshot().items
    expect(items.map((entry) => entry.itemId)).toEqual([
      'codex:thread-1:turn-1:0',
      'codex:thread-1:turn-1:1',
      'codex:thread-1:turn-1:2',
      'codex:thread-1:turn-1:9'
    ])
    expect(items[2]?.body).toEqual({ kind: 'turn', turnId: 'turn-1', state: 'done' })
    await journals.closeAll()
    expect(stored()).toEqual(written)
  })
})

describe('a required field that fails', () => {
  it('is still damage: the open deletes from that row and discloses the repair', async () => {
    const { written } = await journalWith((epoch) => [
      itemRow(epoch, 'codex:thread-1:turn-1:2', {
        kind: 'diff',
        path: 'a.ts',
        patch: { head: 'x' }
      })
    ])
    const journal = await open()
    expect(journal.isReadOnly).toBe(false)
    expect(journal.repair).toEqual({ malformedRows: 1 })
    await journals.closeAll()
    const after = stored()
    expect(after.slice(0, 3)).toEqual(written.slice(0, 3))
    expect(after.some((row) => row.rowJson.includes('"diff"'))).toBe(false)
    expect(after.some((row) => row.rowJson.includes('"after"'))).toBe(false)
  })
})
