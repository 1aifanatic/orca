// The first boot after upgrading: listed chats with history and no status row get their rows from
// their rows alone, one at a time in tab order, with no conversation opened; a chat a crash left
// with work is still opened, so it is settled; and a send during the pass is not queued behind it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
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
import {
  latestRestTestStatus,
  restTestOpens
} from './structured-agent-session-rest-test-observations'

const rigs: RestTestRig[] = []

afterEach(async () => {
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

  it('still opens, and so settles, a rowless chat a crash left mid-turn', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-fine', { message: 'done' })
    await restTestChat(rig, 'session-crashed', { message: 'asked' })
    const [{ providerIdentity }] = await Promise.all(
      rig.adapter.dispatch.mock.results.slice(-1).map((result) => result.value)
    )
    await rig.host
      .collaboratorsForTests()
      .sessions.get('session-crashed')!
      .journal.appendItem(
        { ...providerIdentity, ordinal: 0 },
        { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
        {
          fence: rig.store.getRecord('session-crashed')!.lease.runtimeFence,
          turnScope: { kind: 'thread' }
        }
      )
    await rig.crash()
    upgradeToEmptyStatusTable(rig)
    await rig.boot()

    await rig.host.restoreReadableSessions(await startupThroughListing(rig))

    expect(restTestOpens(rig, 'session-fine')).toBe(0)
    expect(restTestOpens(rig, 'session-crashed')).toBeGreaterThan(0)
    expect(readTestJournalSessionStatus(rig.root, 'session-crashed')).toMatchObject({
      lifecycle: 'idle'
    })
  })

  it('accepts a send during the pass with at most one chat derived ahead of it', async () => {
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

    const pass = rig.host.restoreReadableSessions(background)
    await new Promise((resolve) => setImmediate(resolve))
    const before = derivedCount()
    const sent = await sendRestTestMessage(rig, 'session-send', 'during the pass')
    const after = derivedCount()
    await pass

    expect(sent).toMatchObject({ ok: true })
    expect(after - before).toBeLessThanOrEqual(1)
    expect(after).toBeLessThan(ids.length)
    expect(derivedCount()).toBe(ids.length)
  }, 120_000)

  it('gives each short chat its own task, so a send waits for at most one', async () => {
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
    const before = derivedCount()
    const sent = await sendRestTestMessage(rig, 'session-send', 'during the pass')
    const after = derivedCount()
    await pass
    ticking = false

    expect(sent).toMatchObject({ ok: true })
    expect(after - before).toBeLessThanOrEqual(1)
    expect(after).toBeLessThan(ids.length)
    expect(derivedCount()).toBe(ids.length)
    expect(ticks).toBeGreaterThanOrEqual(ids.length)
  }, 120_000)
})
