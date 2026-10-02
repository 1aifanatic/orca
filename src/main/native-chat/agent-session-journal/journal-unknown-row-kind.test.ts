// A newer build's row kind is never repaired away. Undeclared, it latches this build read-only with
// every row kept. Declared `skip` or `carry` by its writer, it is read past and the chat stays
// writable; a rewind drops a `skip` row and carries a `carry` row into the new epoch.

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
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { readAgentSessionHistory } from '../agent-session-wire/agent-session-history-page'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { parseJournalRow } from './journal-row-schema'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-newer-kind',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-newer-kind-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

/** What a newer build would write: a kind this build does not know, in an ordinary envelope. */
function newerRow(epoch: string, seq: number, extra: Record<string, unknown> = {}) {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    kind: 'future-mark',
    epoch,
    seq,
    fence: 1,
    ts: 5_000 + seq,
    payload: { said: 'by a newer build', seq },
    ...extra
  }
}

function open() {
  return journals.open({ identity: IDENTITY, stateDirectory: root })
}

/** Closes the chat, stores `rows` as a newer build or a bad write would, and reopens it as a
 *  restarted host would. */
async function restartWith(rows: readonly { seq: number; json: string }[]) {
  await journals.closeAll()
  const { db } = openTestJournalHostDatabase(root)
  for (const row of rows) {
    insertTestJournalRowJson(db, IDENTITY.sessionId, row.seq, row.json, 5_000 + row.seq)
  }
  closeTestJournalHostDatabase(root)
  return open()
}

function stored(): { seq: number; json: Record<string, unknown> }[] {
  return liveTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId).map(
    (row) => ({ seq: row.seq, json: JSON.parse(row.rowJson) })
  )
}

function storedNewerRows() {
  return stored().filter((row) => row.json.kind === 'future-mark')
}

/** A journal of its anchor, two items, then a newer build's row at sequence 4. */
async function journalWithNewerRow(extra: Record<string, unknown> = {}) {
  const first = await open()
  await first.appendItem(item(0), { kind: 'status', text: 'before' }, SCOPE)
  await first.appendItem(item(1), { kind: 'status', text: 'also before' }, SCOPE)
  const json = JSON.stringify(newerRow(first.epoch, 4, extra))
  return { journal: await restartWith([{ seq: 4, json }]), json }
}

describe('parsing a row of a kind this build does not know', () => {
  it.each(['skip', 'carry'] as const)('reads past one its writer declared %s', (ifUnknown) => {
    expect(parseJournalRow(JSON.stringify(newerRow('epoch-1', 7, { ifUnknown })))).toEqual({
      ok: false,
      unreadable: false,
      skipped: {
        kind: 'skipped',
        storedKind: 'future-mark',
        ifUnknown,
        epoch: 'epoch-1',
        seq: 7,
        fence: 1,
        ts: 5_007
      }
    })
  })

  it.each([
    ['no declaration', {}],
    ['a declaration this build does not know', { ifUnknown: 'drop' }],
    ['a declaration of the wrong type', { ifUnknown: true }]
  ])('reads one with %s as unreadable', (_name, declared) => {
    const parsed = parseJournalRow(JSON.stringify(newerRow('epoch-1', 7, declared)))
    expect(parsed).toEqual({ ok: false, unreadable: true })
  })

  it.each([
    ['no sequence', { seq: undefined }],
    ['a fractional fence', { fence: 1.5 }],
    ['an empty epoch', { epoch: '' }],
    ['an empty kind', { kind: '' }]
  ])('reads one with %s as malformed, declared or not', (_name, broken) => {
    for (const declared of [{}, { ifUnknown: 'skip' }]) {
      const parsed = parseJournalRow(
        JSON.stringify(newerRow('epoch-1', 7, { ...declared, ...broken }))
      )
      expect(parsed).toEqual({ ok: false, unreadable: false })
    }
  })

  it('reads a known kind that fails its own checks as malformed, whatever it declares', () => {
    const parsed = parseJournalRow(
      JSON.stringify({
        ...newerRow('epoch-1', 7, { ifUnknown: 'skip' }),
        kind: 'item',
        itemId: 'x',
        revision: 1
      })
    )
    expect(parsed).toEqual({ ok: false, unreadable: false })
  })

  it('still latches a future schema version, whatever it declares', () => {
    const parsed = parseJournalRow(
      JSON.stringify(
        newerRow('epoch-1', 7, { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1, ifUnknown: 'skip' })
      )
    )
    expect(parsed).toEqual({ ok: false, unreadable: true })
  })
})

describe("a journal holding a newer build's undeclared row", () => {
  it('opens read-only with the rows before it, refuses writes, and deletes nothing', async () => {
    const { journal, json } = await journalWithNewerRow()
    const before = stored()
    expect(journal.isReadOnly).toBe(true)
    expect(journal.repair).toEqual({ malformedRows: 0 })
    expect(journal.snapshot().items.map((entry) => entry.itemId)).toEqual([
      'codex:thread-1:turn-1:0',
      'codex:thread-1:turn-1:1'
    ])
    await expect(
      journal.appendItem(item(2), { kind: 'status', text: 'after' }, SCOPE)
    ).rejects.toMatchObject({ code: 'journal_read_only' })

    const reopened = await restartWith([])
    expect(reopened.isReadOnly).toBe(true)
    expect(stored()).toEqual(before)
    expect(storedNewerRows()).toEqual([{ seq: 4, json: JSON.parse(json) }])
  })
})

describe("a journal holding a newer build's row declared skippable", () => {
  it('opens with every known row, keeps the row through a write and a reopen, and numbers past it', async () => {
    const { journal, json } = await journalWithNewerRow({ ifUnknown: 'skip' })
    expect(journal.repair).toEqual({ malformedRows: 0 })
    expect(journal.needsRebuild).toBe(false)
    expect(journal.isReadOnly).toBe(false)
    expect(journal.cursor().sequence).toBe(4)
    expect(journal.snapshot().items.map((entry) => entry.itemId)).toEqual([
      'codex:thread-1:turn-1:0',
      'codex:thread-1:turn-1:1'
    ])

    await journal.appendItem(item(2), { kind: 'status', text: 'after' }, SCOPE)
    expect(journal.cursor().sequence).toBe(5)

    const reopened = await restartWith([])
    expect(reopened.repair).toEqual({ malformedRows: 0 })
    expect(reopened.cursor().sequence).toBe(5)
    expect(reopened.snapshot().items).toHaveLength(3)
    expect(stored().map((row) => row.seq)).toEqual([1, 2, 3, 4, 5])
    expect(storedNewerRows()).toEqual([{ seq: 4, json: JSON.parse(json) }])
  })

  it('hands a reader a placeholder that keeps the sequence whole, so catch-up never resets', async () => {
    const { journal } = await journalWithNewerRow({ ifUnknown: 'skip' })
    await journal.appendItem(item(2), { kind: 'status', text: 'after' }, SCOPE)
    const since = journal.readSince({ epoch: journal.epoch, sequence: 3 })
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    expect(since.rows.map((row) => [row.seq, row.kind])).toEqual([
      [4, 'skipped'],
      [5, 'item']
    ])
    const projected = projectJournalBatch({
      rows: since.rows,
      snapshot: journal.snapshot(),
      afterSequence: 3
    })
    expect(projected.ok && projected.batch.items.map((entry) => entry.itemId)).toEqual([
      'codex:thread-1:turn-1:2'
    ])
    expect(projected.ok && projected.batch.removedItemIds).toEqual([])
  })

  it('lets a forward history page step past it, even as the newest row', async () => {
    const { journal } = await journalWithNewerRow({ ifUnknown: 'skip' })
    const page = readAgentSessionHistory(journal, {
      sessionId: IDENTITY.sessionId,
      direction: 'after',
      cursor: { epoch: journal.epoch, sequence: 3 },
      limit: 10
    })
    expect(page).toMatchObject({
      ok: true,
      page: { items: [], hasNewer: false, window: { nextCursor: { sequence: 4 } } }
    })
  })

  it('is dropped by a rewind when declared skip', async () => {
    const { journal } = await journalWithNewerRow({ ifUnknown: 'skip' })
    await journal.replaceEpochItems('handle_forked', 1, [
      { identity: item(0), body: { kind: 'status', text: 'republished' } }
    ])
    expect(stored().map((row) => row.json.kind)).toEqual(['epoch', 'item'])
  })

  it('is carried into the new epoch by a rewind when declared carry, and again by the next one', async () => {
    const { journal, json } = await journalWithNewerRow({ ifUnknown: 'carry' })
    await journal.replaceEpochItems('handle_forked', 1, [
      { identity: item(0), body: { kind: 'status', text: 'republished' } }
    ])
    const firstRewind = journal.epoch
    expect(storedNewerRows()).toEqual([
      { seq: 3, json: { ...JSON.parse(json), epoch: firstRewind, seq: 3 } }
    ])

    const reopened = await restartWith([])
    expect(reopened.repair).toEqual({ malformedRows: 0 })
    expect(reopened.needsRebuild).toBe(false)
    expect(reopened.cursor()).toEqual({ epoch: firstRewind, sequence: 3 })

    await reopened.replaceEpochItems('handle_forked', 1, [])
    expect(storedNewerRows()).toEqual([
      { seq: 2, json: { ...JSON.parse(json), epoch: reopened.epoch, seq: 2 } }
    ])
    await reopened.appendItem(item(5), { kind: 'status', text: 'after the rewinds' }, SCOPE)
    expect(stored().map((row) => row.seq)).toEqual([1, 2, 3])
  })

  it("carries a row after the restated Stop, under the rewinder's fence", async () => {
    const first = await open()
    await first.appendItem(item(0), { kind: 'status', text: 'before' }, SCOPE)
    const at = first.cursor().sequence + 1
    const journal = await restartWith([
      { seq: at, json: JSON.stringify(newerRow(first.epoch, at, { ifUnknown: 'carry' })) }
    ])
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, 1)

    await journal.replaceEpochItems('handle_forked', 3, [])

    expect(stored().map((row) => [row.json.kind, row.json.fence])).toEqual([
      ['epoch', 3],
      ['tombstone', 3],
      ['future-mark', 3]
    ])
    expect(journal.queuedMessages.pauses('host-a').map((pause) => pause.reason)).toEqual([
      'stopped'
    ])
    const reopened = await restartWith([])
    expect(reopened.repair).toEqual({ malformedRows: 0 })
    expect(reopened.cursor().sequence).toBe(3)
    await reopened.appendItem(item(1), { kind: 'status', text: 'after' }, { ...SCOPE, fence: 3 })
    expect(reopened.cursor().sequence).toBe(4)
  })

  // Intended: a roll starts the chat over from nothing, and takes every row of every kind with it.
  it('goes with every other row when the chat is rolled to a new epoch', async () => {
    const { journal } = await journalWithNewerRow({ ifUnknown: 'carry' })
    await journal.rollEpoch('handle_forked', 1)
    expect(stored().map((row) => row.json.kind)).toEqual(['epoch'])
  })
})

describe('real corruption beside a newer row', () => {
  it('still drops the suffix from a malformed row, and keeps the skippable row before it', async () => {
    const first = await open()
    await first.appendItem(item(0), { kind: 'status', text: 'before' }, SCOPE)
    const epoch = first.epoch
    const journal = await restartWith([
      { seq: 3, json: JSON.stringify(newerRow(epoch, 3, { ifUnknown: 'skip' })) },
      { seq: 4, json: '{"not":"a row"}' },
      { seq: 5, json: JSON.stringify(newerRow(epoch, 5, { ifUnknown: 'skip' })) }
    ])
    expect(journal.repair).toEqual({ malformedRows: 1 })
    expect(journal.needsRebuild).toBe(true)
    // 1..3 is the surviving prefix; 4 is the disclosure the repair appends.
    expect(stored().map((row) => [row.seq, row.json.kind])).toEqual([
      [1, 'epoch'],
      [2, 'item'],
      [3, 'future-mark'],
      [4, 'item']
    ])
  })

  it('reads a newer kind whose envelope is broken as malformed and drops from it', async () => {
    const first = await open()
    await first.appendItem(item(0), { kind: 'status', text: 'before' }, SCOPE)
    const journal = await restartWith([
      { seq: 3, json: JSON.stringify(newerRow(first.epoch, 3, { fence: 'one' })) }
    ])
    expect(journal.repair).toEqual({ malformedRows: 1 })
    expect(storedNewerRows()).toEqual([])
  })

  it.each([
    ['a known row', { kind: 'tombstone', itemId: 'gone', revision: 1 }],
    ['a skippable newer row', { ifUnknown: 'skip' }]
  ])(
    'drops %s whose body names another sequence than its key, and writes past it',
    async (_name, shape) => {
      const first = await open()
      await first.appendItem(item(0), { kind: 'status', text: 'before' }, SCOPE)
      // Key 3, body 2: trusting the body would number the next write onto key 3.
      const json = JSON.stringify(newerRow(first.epoch, 2, shape))
      const journal = await restartWith([{ seq: 3, json }])
      expect(journal.repair).toEqual({ malformedRows: 1 })
      expect(journal.needsRebuild).toBe(true)
      expect(stored().map((row) => [row.seq, row.json.kind])).toEqual([
        [1, 'epoch'],
        [2, 'item'],
        [3, 'item']
      ])

      await journal.appendItem(item(1), { kind: 'status', text: 'after' }, SCOPE)
      const reopened = await restartWith([])
      expect(reopened.cursor().sequence).toBe(4)
      expect(reopened.snapshot().items).toHaveLength(3)
    }
  )
})
