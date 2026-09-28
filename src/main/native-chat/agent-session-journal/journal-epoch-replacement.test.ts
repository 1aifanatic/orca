// Republishing an epoch is ONE transaction.

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { journalDatabasePath, type JournalHostDatabase } from './journal-host-database'
import { replaceJournalEpoch } from './journal-epoch-replacement'
import type { JournalLoad } from './journal-open'
import { readJournalSessionEpoch } from './journal-row-table'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()

function now(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function replace(input: {
  items: Parameters<typeof replaceJournalEpoch>[0]['items']
  onPublished?: (loaded: JournalLoad) => void
}): void {
  replaceJournalEpoch({
    database,
    identity: IDENTITY,
    reason: 'legacy_import',
    fence: 1,
    items: input.items,
    now,
    mintEpoch: () => `epoch-${clock}`,
    onPublished: input.onPublished ?? (() => undefined)
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-replace-'))
  clock = 1_000
  database = openTestJournalHostDatabase(root)
})

afterEach(async () => {
  try {
    database.close()
  } catch {
    // Already closed by the case.
  }
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('journal epoch replacement', () => {
  it('publishes one observable replacement', () => {
    const published: JournalLoad[] = []

    replace({
      items: [{ identity: item(1), body: { kind: 'status', text: 'republished' } }],
      onPublished: (loaded) => published.push(loaded)
    })

    expect(published).toHaveLength(1)
    const epoch = readJournalSessionEpoch(database.db, IDENTITY.sessionId)
    expect(epoch).toBe(published[0]?.state.epoch)
    expect(readTestJournalRows(database.db, IDENTITY.sessionId, epoch ?? '')).toHaveLength(2)
  })

  it('discards every superseded row in the same transaction', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    await journal.appendItem(item(1), { kind: 'status', text: 'old' }, { fence: 1 })
    await journal.appendItem(item(2), { kind: 'status', text: 'older' }, { fence: 1 })
    const before = journal.epoch

    await journal.replaceEpochItems('legacy_import', 1, [
      { identity: item(9), body: { kind: 'status', text: 'republished' } }
    ])

    expect(journal.epoch).not.toBe(before)
    expect(readTestJournalRows(database.db, IDENTITY.sessionId, before)).toHaveLength(0)
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([
      { kind: 'status', text: 'republished' }
    ])
  })

  // `auto_vacuum = INCREMENTAL` only marks freed pages; nothing hands them back unless asked. A
  // rewind that replaces a large chat must not leave the file holding its old history forever.
  it('hands the pages a large replace freed back to the filesystem', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const text = 'x'.repeat(4_000)
    for (let ordinal = 1; ordinal <= 400; ordinal += 1) {
      await journal.appendItem(item(ordinal), { kind: 'status', text }, { fence: 1 })
    }
    database.db.pragma('wal_checkpoint(TRUNCATE)')
    const grown = (await stat(journalDatabasePath(root))).size

    await journal.replaceEpochItems('legacy_import', 1, [
      { identity: item(9), body: { kind: 'status', text: 'republished' } }
    ])
    // The replace schedules the reclaim itself; this only waits for it.
    await vi.waitFor(
      () => expect(Number(database.db.pragma('freelist_count', { simple: true }))).toBeLessThan(8),
      { timeout: 2_000 }
    )
    database.db.pragma('wal_checkpoint(TRUNCATE)')
    expect((await stat(journalDatabasePath(root))).size).toBeLessThan(grown / 4)
  })
})
