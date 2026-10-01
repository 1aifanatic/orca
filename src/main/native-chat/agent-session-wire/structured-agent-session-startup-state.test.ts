// Host startup from each chat's stored state: settled chats get their status rows without being
// opened, every chat that owes work is settled with no user action (tab or no tab), and a chat is
// opened only when stored state cannot answer for it.

import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRow,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { readJournalSessionState } from '../agent-session-journal/journal-session-state'
import Database from '../../sqlite/sync-database'
import {
  createRestTestRig,
  latestRestTestStatus,
  restTestChat,
  restTestOpens,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

const rigs: RestTestRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

async function newRig(root?: string): Promise<RestTestRig> {
  const rig = await createRestTestRig({}, root ? { root } : {})
  rigs.push(rig)
  return rig
}

function db(rig: RestTestRig) {
  return openTestJournalHostDatabase(rig.root).db
}

/** A send the provider only admitted, so it stays unanswered: the crash leaves it owed. */
async function crashMidSend(rig: RestTestRig, sessionId: string, listed = true): Promise<void> {
  rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, listed })
}

/** What startup runs, in order, on the ids the tab list names. */
async function startup(rig: RestTestRig, listed: readonly string[]) {
  await rig.host.reconcileRestartLeases()
  const background = rig.host.seedStoredStatuses(listed)
  await rig.host.settleOwedSessions(listed)
  await rig.host.restoreReadableSessions(background)
  return background
}

function opened(rig: RestTestRig, ids: readonly string[]): string[] {
  return ids.filter((sessionId) => restTestOpens(rig, sessionId) > 0)
}

function statusRows(rig: RestTestRig, sessionId: string): AgentSessionStatusSummary[] {
  return rig.statusEvents.flatMap((event) =>
    event.type === 'status' && event.session.sessionId === sessionId ? [event.session] : []
  )
}

const listedIds = (rig: RestTestRig) => rig.store.getVisibleSessionTabIndex().sessionIds

describe('seeding statuses from stored state', () => {
  it('seeds each settled chat exactly as its open would publish it (T5)', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-answered', { message: 'finished work' })
    await restTestChat(rig, 'session-quiet')
    rig.adapter.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
        surface: 'rejection'
      })
    })
    await restTestChat(rig, 'session-refused', { message: 'refused' })
    await rig.host.flushAllStreamedEvents()
    const ids = ['session-answered', 'session-quiet', 'session-refused']
    closeTestJournalHostDatabases()
    const readRoot = `${rig.root}-read`
    await cp(rig.root, readRoot, { recursive: true })
    const readRig = await newRig(readRoot)

    const host = await rig.boot()
    await host.reconcileRestartLeases()
    expect(host.seedStoredStatuses(ids)).toEqual([])
    expect(opened(rig, ids)).toEqual([])
    // The same chats in another run, each opened by a read.
    await readRig.host.reconcileRestartLeases()
    for (const sessionId of ids) {
      await readRig.host.history({ sessionId, direction: 'tail' })
    }

    for (const sessionId of ids) {
      // Every field, `updatedAt` included: both come from the journal's own newest activity.
      expect(latestRestTestStatus(rig, sessionId)).toEqual(latestRestTestStatus(readRig, sessionId))
    }
    expect(latestRestTestStatus(rig, 'session-refused')).toMatchObject({ turnOutcome: 'failure' })
    // Opening a seeded chat finds its row equal and sends nothing.
    const seeded = ids.map((sessionId) => statusRows(rig, sessionId).length)
    for (const sessionId of ids) {
      await host.history({ sessionId, direction: 'tail' })
    }
    expect(ids.map((sessionId) => statusRows(rig, sessionId).length)).toEqual(seeded)
  })

  it('seeds a crash-cut turn with the verdict its open publishes (T5, interrupted and unconfirmed)', async () => {
    const rig = await newRig()
    const ids = ['session-interrupted', 'session-unconfirmed']
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
      const [{ providerIdentity }] = await Promise.all(
        rig.adapter.dispatch.mock.results.slice(-1).map((result) => result.value)
      )
      const session = rig.host.collaboratorsForTests().sessions.get(sessionId)!
      // The turn's own row, beside the accepted message the dispatch's identity names.
      await session.journal.appendItem(
        { ...providerIdentity, ordinal: 0 },
        { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
        {
          fence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
          turnScope: { kind: 'thread' }
        }
      )
    }
    await rig.crash()
    // The unconfirmed chat's owner can never be judged; the other's is proven gone.
    const probe = async (record: { sessionId: string }) =>
      record.sessionId === 'session-unconfirmed'
        ? { outcome: 'indeterminate' as const, reason: 'no start time' }
        : { outcome: 'pid-absent' as const }
    rig.probeOwner.mockImplementation(probe)
    await rig.boot()
    await startup(rig, ids)
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    closeTestJournalHostDatabases()
    const readRoot = `${rig.root}-read`
    await cp(rig.root, readRoot, { recursive: true })
    const readRig = await newRig(readRoot)
    readRig.probeOwner.mockImplementation(probe)

    const host = await rig.boot()
    await host.reconcileRestartLeases()
    expect(host.seedStoredStatuses(ids)).toEqual([])
    expect(opened(rig, ids)).toEqual([])
    await readRig.host.reconcileRestartLeases()
    for (const sessionId of ids) {
      await readRig.host.history({ sessionId, direction: 'tail' })
    }

    for (const sessionId of ids) {
      expect(latestRestTestStatus(rig, sessionId)).toEqual(latestRestTestStatus(readRig, sessionId))
    }
    expect(latestRestTestStatus(rig, 'session-interrupted')).toMatchObject({
      turnOutcome: 'interruption'
    })
    expect(latestRestTestStatus(rig, 'session-unconfirmed')).toMatchObject({
      turnOutcome: 'unconfirmed'
    })
  })

  it('has every settled chat in the first snapshot a later subscriber gets (T8, T17)', async () => {
    const rig = await newRig()
    for (const sessionId of ['session-1', 'session-2']) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await rig.crash()
    const host = await rig.boot()
    host.seedStoredStatuses(listedIds(rig))
    const snapshots: AgentSessionStatusSummary[][] = []
    host.subscribeStatus({
      id: 'remote-client',
      emit: (event) => {
        if (event.type === 'snapshot') {
          snapshots.push(event.sessions)
        }
      }
    })
    expect(snapshots[0]?.map((row) => [row.sessionId, row.status])).toEqual([
      ['session-1', 'idle'],
      ['session-2', 'idle']
    ])
  })

  it('reaches the status observers once per seeded chat, as a replay (T13)', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-1', { message: 'hi' })
    await rig.crash()
    const onSessionStatusChanged = vi.fn()
    const host = await rig.boot({ onSessionStatusChanged })
    host.seedStoredStatuses(['session-1'])
    expect(onSessionStatusChanged).toHaveBeenCalledOnce()
    expect(onSessionStatusChanged).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', status: 'idle' }),
      { replay: true }
    )
  })

  it('drops a seeded chat from the status store when its tab closes (T12)', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-1', { message: 'hi' })
    await rig.crash()
    const host = await rig.boot()
    host.seedStoredStatuses(['session-1'])
    expect(rig.sink.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.anything()
    )

    await host.setSessionTabVisibility('session-1', false)

    expect(host.hasSession('session-1')).toBe(false)
    expect(rig.sink.forget).toHaveBeenCalledOnce()
  })

  it('seeds nothing and settles nothing from a newer build database (T16, regression guard)', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-crashed')
    await restTestChat(rig, 'session-settled', { message: 'done' })
    await rig.crash()
    closeTestJournalHostDatabases()
    const raw = new Database(join(rig.root, 'agent-session-journal.db'))
    raw.pragma('user_version = 99')
    raw.close()
    const host = await rig.boot()
    const ids = listedIds(rig)

    expect(host.seedStoredStatuses(ids)).toEqual(ids)
    await host.settleOwedSessions(ids)
    expect(rig.sink.publish).not.toHaveBeenCalled()
    expect(opened(rig, ids)).toEqual([])
  })
})

describe('startup opens only what it must (T6, T7, T14)', () => {
  it('settles crashed chats with or without a tab, and opens only what stored state cannot answer', async () => {
    const rig = await newRig()
    const settled = Array.from({ length: 8 }, (_, index) => `session-settled-${index}`)
    for (const sessionId of settled) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await crashMidSend(rig, 'session-crashed')
    await crashMidSend(rig, 'session-crashed-closed', false)
    await crashMidSend(rig, 'session-crashed-state-lost', false)
    for (const sessionId of [
      'session-stale',
      'session-repaired',
      'session-draft',
      'session-uncopied'
    ]) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await rig.crash()

    const live = (sessionId: string) =>
      String(
        db(rig).prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?').get(sessionId)
          ?.epoch
      )
    const tip = (sessionId: string) => readJournalSessionState(db(rig), sessionId)!
    const appendPastState = (sessionId: string) =>
      insertTestJournalRow(db(rig), sessionId, {
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        kind: 'item',
        itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'unstored-note' }),
        revision: 1,
        body: { kind: 'status', text: 'no state stored beside it' },
        epoch: live(sessionId),
        seq: tip(sessionId).seq + 1,
        fence: 1,
        ts: 9_000
      })
    // An older build appended past the stored state.
    appendPastState('session-stale')
    // A kill between a commit and its state write: the row is one behind, still owing.
    appendPastState('session-crashed-state-lost')
    // An older build repaired the chat after its state was stored, and wrote back to that sequence.
    db(rig)
      .prepare(
        'INSERT INTO journal_repairs (session_id, epoch, content_from, repaired_at) VALUES (?, ?, ?, ?)'
      )
      .run(
        'session-repaired',
        live('session-repaired'),
        tip('session-repaired').seq,
        tip('session-repaired').writtenAt + 1
      )
    // A draft an earlier process queued: paused by the restart, so an open would send nothing.
    db(rig)
      .prepare(
        `INSERT INTO queued_messages (session_id, message_id, position, body_json, fingerprint,
        created_at, host_instance, state) VALUES (?, 'draft-1', 1, ?, 'fp', 1, 'host-a', 'waiting')`
      )
      .run(
        'session-draft',
        JSON.stringify({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'x' }] })
      )
    // Still in the format a pre-database build wrote: nothing of it is in the host's database.
    for (const table of ['journal_rows', 'journal_sessions', 'journal_session_state']) {
      db(rig).prepare(`DELETE FROM ${table} WHERE session_id = ?`).run('session-uncopied')
    }
    const legacy = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
      workspaceId: 'workspace-1',
      sessionId: 'session-uncopied'
    })
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'log.jsonl'), '{}\n')

    await rig.boot()
    const listed = listedIds(rig)
    expect(listed).not.toContain('session-crashed-closed')
    const background = await startup(rig, listed)

    const unlisted = ['session-crashed-closed', 'session-crashed-state-lost']
    expect(opened(rig, [...listed, ...unlisted]).toSorted()).toEqual(
      [
        'session-crashed',
        ...unlisted,
        'session-repaired',
        'session-stale',
        'session-uncopied'
      ].toSorted()
    )
    expect(background.toSorted()).toEqual(
      ['session-repaired', 'session-stale', 'session-uncopied'].toSorted()
    )
    expect(latestRestTestStatus(rig, 'session-draft')).toMatchObject({ status: 'idle' })
    // Settled with no user action; the listed one is open and never showed its pre-crash work.
    for (const sessionId of ['session-crashed', ...unlisted]) {
      // The unanswered send is now recovered doubt, which projects as no running request.
      expect(readJournalSessionState(db(rig), sessionId)).toMatchObject({
        owesWork: false,
        summary: { status: null }
      })
    }
    expect(rig.host.hasSession('session-crashed')).toBe(true)
    expect(statusRows(rig, 'session-crashed').map((row) => row.status)).not.toContain('working')
    // The tabless ones are settled and closed: never indexed, never given a status row (T14).
    for (const sessionId of unlisted) {
      expect(rig.host.hasSession(sessionId)).toBe(false)
      expect(rig.sink.publish.mock.calls.filter(([row]) => row.sessionId === sessionId)).toEqual([])
    }
    // Every settled chat has its row without being opened.
    for (const sessionId of settled) {
      expect(latestRestTestStatus(rig, sessionId)).toMatchObject({ status: 'idle' })
    }

    // The next boot finds nothing owed and nothing stale (T4b).
    await rig.crash()
    await rig.boot()
    const again = await startup(rig, listedIds(rig))
    expect(again).toEqual([])
    expect(opened(rig, [...listedIds(rig), ...unlisted])).toEqual([])
  })
})
