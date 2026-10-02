// The first boot after upgrading: listed chats with history and no status row get their rows from
// their rows alone, folded one at a time in the order given and written a slice at a time, with no
// conversation opened; a chat a crash left with work is still opened, so it is settled; and a send
// during the pass is not queued behind it.

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type * as StatusBackfillModule from '../agent-session-journal/journal-session-status-backfill'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRow,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import {
  createRestTestRig,
  restTestChat,
  sendRestTestMessage,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { readUnsettledJournalSessionIds } from '../agent-session-journal/journal-session-state'
import {
  latestRestTestStatus,
  restTestOpens
} from './structured-agent-session-rest-test-observations'

// The chats folded so far, whether or not their slice's rows are written yet.
const folds = vi.hoisted(() => {
  const hooks: {
    done: Set<string>
    /** Runs as each fold ends, before its slice is written. */
    after: ((sessionId: string) => Promise<void>) | null
  } = { done: new Set(), after: null }
  return hooks
})

vi.mock('../agent-session-journal/journal-session-status-backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof StatusBackfillModule>()
  return {
    ...actual,
    foldJournalSessionStatus: async (
      ...args: Parameters<typeof actual.foldJournalSessionStatus>
    ) => {
      const folded = await actual.foldJournalSessionStatus(...args)
      folds.done.add(args[1])
      await folds.after?.(args[1])
      return folded
    }
  }
})

const rigs: RestTestRig[] = []

afterEach(async () => {
  folds.done.clear()
  folds.after = null
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

async function newRig(): Promise<RestTestRig> {
  const rig = await createRestTestRig()
  rigs.push(rig)
  return rig
}

/** Every chat's row dropped, as version 5 finds a database an older build wrote. */
function upgradeToEmptyStatusTable(rig: RestTestRig): void {
  openTestJournalHostDatabase(rig.root).db.prepare('DELETE FROM journal_session_state').run()
}

const listedIds = (rig: RestTestRig) => rig.store.getVisibleSessionTabIndex().sessionIds

/** Startup up to the listing, as the host runs it; answers what the background pass is owed. */
async function startupThroughListing(rig: RestTestRig): Promise<string[]> {
  const listed = listedIds(rig)
  await rig.host.reconcileRestartLeases()
  const background = rig.host.seedStoredStatuses(listed)
  await rig.host.settleOwedSessions(listed)
  return background
}

/** A chat whose turn was still running when Orca died. */
async function crashMidTurn(rig: RestTestRig, sessionId: string): Promise<void> {
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
  const { providerIdentity } = await rig.adapter.dispatch.mock.results.at(-1)!.value
  await rig.host
    .collaboratorsForTests()
    .sessions.get(sessionId)!
    .journal.appendItem(
      { ...providerIdentity, ordinal: 0 },
      { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
      { fence: rig.store.getRecord(sessionId)!.lease.runtimeFence, turnScope: { kind: 'thread' } }
    )
}

/** Appends `count` short status items to each chat's history, as a stopped Orca left them. */
function appendHistory(rig: RestTestRig, sessionIds: readonly string[], count: number): void {
  const { db } = openTestJournalHostDatabase(rig.root)
  db.exec('BEGIN')
  for (const sessionId of sessionIds) {
    const tip = liveTestJournalRows(db, sessionId).at(-1)!
    for (let index = 0; index < count; index += 1) {
      insertTestJournalRow(db, sessionId, {
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        kind: 'item',
        epoch: tip.epoch,
        seq: tip.seq + 1 + index,
        fence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
        ts: 1_000 + index,
        itemId: `${sessionId}-note-${index}`,
        revision: 1,
        body: { kind: 'status', text: `note ${index}` }
      })
    }
  }
  db.exec('COMMIT')
}

const seeded = (rig: RestTestRig, sessionId: string) =>
  rig.statusEvents.findIndex(
    (event) => event.type === 'status' && event.session.sessionId === sessionId
  )

describe('rowless listed chats after an upgrade', () => {
  it('get their rows from their rows alone, in tab order, with no chat opened', async () => {
    const rig = await newRig()
    const ids = Array.from({ length: 12 }, (_, index) => `session-${index}`)
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const background = await startupThroughListing(rig)
    expect(background).toEqual(listedIds(rig))

    await rig.host.restoreReadableSessions(background)

    for (const sessionId of ids) {
      expect(readTestJournalSessionStatus(rig.root, sessionId)).toMatchObject({ lifecycle: 'idle' })
      expect(latestRestTestStatus(rig, sessionId)).toMatchObject({ status: 'idle' })
      expect(restTestOpens(rig, sessionId)).toBe(0)
    }
    const order = ids.map((sessionId) => seeded(rig, sessionId))
    expect(order).toEqual(order.toSorted((a, b) => a - b))
  })

  it('shows no status for a rowless chat until it has a row, and never seeds an unfinished one from its rows', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-fine', { message: 'done' })
    // A turn still running, and an approval still waiting, when Orca died.
    const unfinished = ['session-running', 'session-prompt']
    for (const sessionId of unfinished) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
      const { providerIdentity } = await rig.adapter.dispatch.mock.results.at(-1)!.value
      const journal = rig.host.collaboratorsForTests().sessions.get(sessionId)!.journal
      const options = {
        fence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
        turnScope: { kind: 'thread' as const }
      }
      await (sessionId === 'session-running'
        ? journal.appendItem(
            { ...providerIdentity, ordinal: 0 },
            { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
            options
          )
        : journal.appendItem(
            { ...providerIdentity, ordinal: 50 },
            {
              kind: 'approval',
              title: 'Approve?',
              detail: null,
              options: [],
              resolution: {
                state: 'pending',
                selectedOptionId: null,
                resolvedBy: null,
                resolvedAt: null
              }
            },
            options
          ))
    }
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const background = await startupThroughListing(rig)
    // No row yet: no status at all, rather than a guess.
    for (const sessionId of ['session-fine', ...unfinished]) {
      expect(latestRestTestStatus(rig, sessionId)).toBeUndefined()
    }
    // The status stream's length when each chat first opened.
    const openedAt = new Map<string, number>()
    rig.adapter.historyFilePath.mockImplementation(async (sessionId) => {
      if (!openedAt.has(sessionId)) {
        openedAt.set(sessionId, rig.statusEvents.length)
      }
      return null
    })

    await rig.host.restoreReadableSessions(background)

    expect(restTestOpens(rig, 'session-fine')).toBe(0)
    expect(latestRestTestStatus(rig, 'session-fine')).toMatchObject({ status: 'idle' })
    for (const sessionId of unfinished) {
      // Its first status comes from its open, which settles it: never a row derived beforehand.
      expect(openedAt.get(sessionId)).toBeDefined()
      expect(seeded(rig, sessionId)).toBeGreaterThanOrEqual(openedAt.get(sessionId)!)
      expect(readTestJournalSessionStatus(rig.root, sessionId)).toMatchObject({ lifecycle: 'idle' })
      expect(latestRestTestStatus(rig, sessionId)?.status).not.toBe('attention')
      expect(latestRestTestStatus(rig, sessionId)?.status).not.toBe('working')
    }
  })

  it('appends few WAL pages for a pass of 247 chats: their rows are written a slice at a time', async () => {
    const rig = await newRig()
    const ids = Array.from({ length: 247 }, (_, index) => `session-page-${index}`)
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const background = await startupThroughListing(rig)
    const { db } = openTestJournalHostDatabase(rig.root)
    // An empty WAL, so its size after the pass is what the pass appended.
    db.pragma('wal_checkpoint(TRUNCATE)')
    const pageSize = Number(db.pragma('page_size', { simple: true }))

    await rig.host.restoreReadableSessions(background)

    const frames =
      (statSync(join(rig.root, 'agent-session-journal.db-wal')).size - 32) / (pageSize + 24)
    expect(ids.every((sessionId) => readTestJournalSessionStatus(rig.root, sessionId))).toBe(true)
    expect(
      ids.map((sessionId) => restTestOpens(rig, sessionId)).every((opens) => opens === 0)
    ).toBe(true)
    // A commit per chat appends about 2.5 pages each, over 600 for this pass.
    expect(frames).toBeLessThanOrEqual(150)
  }, 120_000)

  it('accepts a send during the pass with at most one chat folded, and one slice written, ahead of it', async () => {
    const rig = await newRig()
    const ids = Array.from({ length: 6 }, (_, index) => `session-long-${index}`)
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
      const journal = rig.host.collaboratorsForTests().sessions.get(sessionId)!.journal
      const fence = rig.store.getRecord(sessionId)!.lease.runtimeFence
      // Long enough that its fold takes several parts, as a long chat's does.
      for (let index = 0; index < 1_200; index += 1) {
        await journal.appendItem(
          { provider: 'orca', clientMessageId: `${sessionId}-note-${index}` },
          { kind: 'status', text: `${index} ${'x'.repeat(400)}` },
          { fence, turnScope: { kind: 'thread' } }
        )
      }
    }
    await restTestChat(rig, 'session-send', { message: 'first' })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    // The chat the send goes to keeps its row; the long ones are the pass's.
    await rig.boot()
    const background = (await startupThroughListing(rig)).filter((id) => id !== 'session-send')
    const derivedCount = () =>
      ids.filter((sessionId) => readTestJournalSessionStatus(rig.root, sessionId) !== null).length
    const foldedCount = () => ids.filter((sessionId) => folds.done.has(sessionId)).length

    let ticks = 0
    let ticking = true
    const tick = (): void => {
      if (ticking) {
        ticks += 1
        setImmediate(tick)
      }
    }
    setImmediate(tick)

    const pass = rig.host.restoreReadableSessions(background)
    await new Promise((resolve) => setImmediate(resolve))
    const before = foldedCount()
    const sent = await sendRestTestMessage(rig, 'session-send', 'during the pass')
    const after = foldedCount()
    await pass
    ticking = false

    expect(sent).toMatchObject({ ok: true })
    expect(after - before).toBeLessThanOrEqual(1)
    expect(after).toBeLessThan(ids.length)
    expect(derivedCount()).toBe(ids.length)
    // Each long chat folds over several tasks, not one.
    expect(ticks).toBeGreaterThanOrEqual(2 * ids.length)
  }, 120_000)

  it('gives each short chat its own task, so a send waits for at most one fold and one slice write', async () => {
    const rig = await newRig()
    // Each folds in a single part, so only a yield between chats splits the pass.
    const ids = Array.from({ length: 60 }, (_, index) => `session-short-${index}`)
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await restTestChat(rig, 'session-send', { message: 'first' })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    appendHistory(rig, ids, 150)
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const background = (await startupThroughListing(rig)).filter((id) => id !== 'session-send')
    const derivedCount = () =>
      ids.filter((sessionId) => readTestJournalSessionStatus(rig.root, sessionId) !== null).length
    const foldedCount = () => ids.filter((sessionId) => folds.done.has(sessionId)).length
    let ticks = 0
    let ticking = true
    const tick = (): void => {
      if (ticking) {
        ticks += 1
        setImmediate(tick)
      }
    }
    setImmediate(tick)

    const pass = rig.host.restoreReadableSessions(background)
    await new Promise((resolve) => setImmediate(resolve))
    const before = foldedCount()
    const sent = await sendRestTestMessage(rig, 'session-send', 'during the pass')
    const after = foldedCount()
    await pass
    ticking = false

    expect(sent).toMatchObject({ ok: true })
    expect(after - before).toBeLessThanOrEqual(1)
    expect(after).toBeLessThan(ids.length)
    expect(derivedCount()).toBe(ids.length)
    expect(ticks).toBeGreaterThanOrEqual(ids.length)
  }, 120_000)

  it('writes the row of a chat whose tab closes mid-pass, but gives it no sidebar row', async () => {
    const rig = await newRig()
    for (const sessionId of ['session-kept', 'session-closing']) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const background = await startupThroughListing(rig)
    // The tab closes after the chat's fold, before its slice is written.
    folds.after = async (sessionId) => {
      if (sessionId === 'session-closing') {
        await rig.host.setSessionTabVisibility(sessionId, false)
      }
    }

    await rig.host.restoreReadableSessions(background)

    expect(readTestJournalSessionStatus(rig.root, 'session-closing')).toMatchObject({
      lifecycle: 'idle'
    })
    expect(seeded(rig, 'session-closing')).toBe(-1)
    expect(restTestOpens(rig, 'session-closing')).toBe(0)
    expect(latestRestTestStatus(rig, 'session-kept')).toMatchObject({ status: 'idle' })
  })

  it("stores an unfinished chat's row unshown, so a tab closed before its open is still settled on the next boot", async () => {
    const rig = await newRig()
    await crashMidTurn(rig, 'session-crashed')
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()
    const background = await startupThroughListing(rig)
    // Closed after its fold, so the pass's open of it never happens.
    folds.after = async (sessionId) => {
      if (sessionId === 'session-crashed') {
        await rig.host.setSessionTabVisibility(sessionId, false)
      }
    }

    await rig.host.restoreReadableSessions(background)

    expect(restTestOpens(rig, 'session-crashed')).toBe(0)
    expect(seeded(rig, 'session-crashed')).toBe(-1)
    expect(readTestJournalSessionStatus(rig.root, 'session-crashed')).toMatchObject({
      lifecycle: 'running'
    })
    expect(readUnsettledJournalSessionIds(openTestJournalHostDatabase(rig.root).db)).toEqual([
      'session-crashed'
    ])

    // The next boot selects it from its row and settles it, tab or no tab.
    folds.after = null
    await rig.crash()
    await rig.boot()
    await startupThroughListing(rig)
    expect(restTestOpens(rig, 'session-crashed')).toBeGreaterThan(0)
    expect(readTestJournalSessionStatus(rig.root, 'session-crashed')).toMatchObject({
      lifecycle: 'idle'
    })
  })
})
