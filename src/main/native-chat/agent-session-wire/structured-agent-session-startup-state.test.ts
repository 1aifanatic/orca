// Host startup from each chat's stored state: settled chats get their status rows without being
// opened, every chat that owes work is settled with no user action (tab or no tab), and a chat is
// opened only when stored state cannot answer for it.

import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import Database from '../../sqlite/sync-database'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { readUnsettledJournalSessionIds } from '../agent-session-journal/journal-session-state'
import { StructuredAgentSessionStartupGate } from '../../runtime/structured-agent-session-startup-gate'
import { writeOlderBuildLease } from '../../runtime/agent-session-older-build-lease.test-fixture'
import { editPersistedTestAgentSessionStore } from '../../runtime/agent-session-record-store-test-harness'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestChat,
  sendRestTestMessage,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  crashRestTestChatMidTurn,
  runRestTestStartup
} from './structured-agent-session-rest-test-startup'
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
  it('has every settled chat in the first snapshot a later subscriber gets (T8, T17)', async () => {
    const rig = await newRig()
    for (const sessionId of ['session-1', 'session-2']) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await rig.crash()
    const host = await rig.boot()
    host.startup.seedStoredStatuses(listedIds(rig))
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
    host.startup.seedStoredStatuses(['session-1'])
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
    host.startup.seedStoredStatuses(['session-1'])
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

    expect(host.startup.seedStoredStatuses(ids)).toEqual(ids)
    await host.startup.settleOwedSessions(ids)
    expect(rig.sink.publish).not.toHaveBeenCalled()
    expect(opened(rig, ids)).toEqual([])
  })
})

/** A copy of the rig's files for a second host, which reads each chat directly; taken while
 *  nothing is writing. */
async function readCopy(
  rig: RestTestRig,
  probe?: Parameters<RestTestRig['probeOwner']['mockImplementation']>[0]
): Promise<RestTestRig> {
  closeTestJournalHostDatabases()
  const readRoot = `${rig.root}-read`
  await cp(rig.root, readRoot, { recursive: true })
  const readRig = await newRig(readRoot)
  if (probe) {
    readRig.probeOwner.mockImplementation(probe)
  }
  return readRig
}

async function readEach(rig: RestTestRig, ids: readonly string[]): Promise<void> {
  await rig.host.reconcileRestartLeases()
  for (const sessionId of ids) {
    await rig.host.history({ sessionId, direction: 'tail' })
  }
}

describe('startup statuses end where a direct read of each chat lands', () => {
  it('seeds each settled chat exactly as its open would publish it, crash-cut verdicts included (T5)', async () => {
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
    for (const sessionId of ['session-interrupted', 'session-unconfirmed']) {
      await crashRestTestChatMidTurn(rig, sessionId)
    }
    const ids = [
      'session-answered',
      'session-quiet',
      'session-refused',
      'session-interrupted',
      'session-unconfirmed'
    ]
    await rig.crash()
    // The unconfirmed chat's owner can never be judged; every other one is proven gone.
    const probe = async (record: { sessionId: string }) =>
      record.sessionId === 'session-unconfirmed'
        ? { outcome: 'indeterminate' as const, reason: 'no start time' }
        : { outcome: 'pid-absent' as const }
    rig.probeOwner.mockImplementation(probe)
    // The first launch settles the crash-cut turns; the next seeds every chat from its row.
    await rig.boot()
    await runRestTestStartup(rig, ids)
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    const readRig = await readCopy(rig, probe)

    const host = await rig.boot()
    await host.reconcileRestartLeases()
    expect(host.startup.seedStoredStatuses(ids)).toEqual([])
    expect(opened(rig, ids)).toEqual([])
    await readEach(readRig, ids)

    for (const sessionId of ids) {
      // Every field, `updatedAt` included: both come from the journal's own newest activity.
      expect(latestRestTestStatus(rig, sessionId)).toEqual(latestRestTestStatus(readRig, sessionId))
    }
    expect(latestRestTestStatus(rig, 'session-refused')).toMatchObject({ turnOutcome: 'failure' })
    expect(latestRestTestStatus(rig, 'session-interrupted')).toMatchObject({
      turnOutcome: 'interruption'
    })
    expect(latestRestTestStatus(rig, 'session-unconfirmed')).toMatchObject({
      turnOutcome: 'unconfirmed'
    })
    // Opening a seeded chat finds its row equal and sends nothing.
    const seeded = ids.map((sessionId) => statusRows(rig, sessionId).length)
    for (const sessionId of ids) {
      await host.history({ sessionId, direction: 'tail' })
    }
    expect(ids.map((sessionId) => statusRows(rig, sessionId).length)).toEqual(seeded)
  })

  it('ends every chat the restore after the listing opens where a direct read lands, with no pre-crash work (T8)', async () => {
    const rig = await newRig()
    const ids = ['session-settled', 'session-quiet', 'session-crashed', 'session-pending']
    // Two a clean quit settled, one cut off mid-turn by a crash, and one whose send the provider
    // only admitted, left pending below a fence that has since moved.
    await restTestChat(rig, 'session-settled', { message: 'finished work' })
    await restTestChat(rig, 'session-quiet')
    await rig.host.flushAllStreamedEvents()
    await rig.boot()
    await restTestChat(rig, 'session-crashed', { message: 'cut off' })
    rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    await restTestChat(rig, 'session-pending', { message: 'only admitted' })
    await rig.crash()
    // A live lease names the link proven at its fence, so the fence moves with that link.
    await rig.store.transitionHandoff('session-pending', (record) => ({
      ...record,
      lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 },
      providerHandleChain: record.providerHandleChain.map((link, index, chain) =>
        index === chain.length - 1 ? { ...link, mintedAtFence: link.mintedAtFence + 1 } : link
      )
    }))
    const readRig = await readCopy(rig)

    const host = await rig.boot()
    await host.reconcileRestartLeases()
    await host.restoreReadableSessions(ids)
    await readEach(readRig, ids)

    // `updatedAt` is when the row was projected, a wall-clock read that differs between two boots.
    const rows = (of: RestTestRig): Record<string, Omit<AgentSessionStatusSummary, 'updatedAt'>> =>
      Object.fromEntries(
        ids.flatMap((sessionId) => {
          const summary = latestRestTestStatus(of, sessionId)
          if (!summary) {
            return []
          }
          const { updatedAt: _updatedAt, ...row } = summary
          return [[sessionId, row]]
        })
      )
    await vi.waitFor(() => expect(rows(rig)).toEqual(rows(readRig)))
    expect(Object.keys(rows(rig))).toEqual(ids)
    expect(statusRows(rig, 'session-crashed').map((row) => row.status)).not.toContain('working')
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
    for (const sessionId of ['session-rowless', 'session-draft', 'session-uncopied']) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await rig.crash()

    // Last written before its status table existed: it has a journal and no status.
    db(rig).prepare('DELETE FROM journal_session_state WHERE session_id = ?').run('session-rowless')
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
    const background = await runRestTestStartup(rig, listed)

    const unlisted = ['session-crashed-closed']
    expect(opened(rig, [...listed, ...unlisted]).toSorted()).toEqual(
      ['session-crashed', ...unlisted, 'session-rowless', 'session-uncopied'].toSorted()
    )
    // No stored status to answer from: both are left to the restore after the listing.
    expect(background).toEqual(['session-rowless', 'session-uncopied'])
    expect(latestRestTestStatus(rig, 'session-draft')).toMatchObject({ status: 'idle' })
    // Settled with no user action; the listed one is open and never showed its pre-crash work.
    for (const sessionId of ['session-crashed', ...unlisted]) {
      // The unanswered send is now recovered doubt, which projects as no running request.
      expect(readTestJournalSessionStatus(rig.root, sessionId)).toMatchObject({
        lifecycle: 'idle',
        handedOverSends: 0,
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

    // The rowless chat's open writes its status back and publishes it.
    expect(readTestJournalSessionStatus(rig.root, 'session-rowless')).toMatchObject({
      lifecycle: 'idle'
    })
    expect(latestRestTestStatus(rig, 'session-rowless')).toMatchObject({ status: 'idle' })

    // The next boot finds nothing to settle and nothing without a status (T4b).
    await rig.crash()
    await rig.boot()
    const again = await runRestTestStartup(rig)
    expect(again).toEqual([])
    expect(opened(rig, [...listedIds(rig), ...unlisted])).toEqual([])
  })
})

describe('a provider process that outlived the crash (R1T-2)', () => {
  it('is stopped at startup for a listed and an unlisted chat, and none is left on the next boot', async () => {
    const rig = await newRig()
    // Attached, then sent to: its provider process is live when Orca dies.
    for (const [id, listed] of [
      ['session-idle-listed', true],
      ['session-idle-closed', false]
    ] as const) {
      await restTestChat(rig, id, { listed })
      await restTestChat(rig, id, { message: 'done', listed })
    }
    const ids = ['session-idle-listed', 'session-idle-closed']
    // Each chat's provider process was still up when Orca died: its lease names it, live.
    const leases = ids.map((id) => rig.store.getRecord(id)!.lease)
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    for (const lease of leases) {
      await writeOlderBuildLease(rig.root, lease.sessionId, { ...lease })
    }
    // The rig's chats share one recorded process; stopping it ends both.
    let alive = true
    const stopOwnerProcess = vi.fn(() => {
      alive = false
    })
    rig.probeOwner.mockImplementation(async () =>
      alive
        ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        : { outcome: 'pid-absent' }
    )

    await rig.boot({ stopOwnerProcess })
    await runRestTestStartup(rig)

    expect(stopOwnerProcess).toHaveBeenCalled()
    expect(alive).toBe(false)
    for (const id of ids) {
      expect(rig.store.getRecord(id)!.lease).toMatchObject({
        handoffStage: null,
        ownerProcess: null,
        deathEvidence: { kind: 'pid-absent' }
      })
    }
    // The listed chat was seeded, not opened, and still had its process stopped.
    expect(opened(rig, ids)).toEqual([])

    await rig.crash()
    stopOwnerProcess.mockClear()
    await rig.boot({ stopOwnerProcess })
    await runRestTestStartup(rig)
    expect(stopOwnerProcess).not.toHaveBeenCalled()
  })

  it.each([
    { check: "'s first try fails", fails: 1, command: null, checks: 2, stopped: 1 },
    { check: ' fails twice', fails: 2, command: null, checks: 2, stopped: 0 },
    {
      check: ' fails twice and a command checks the leases before the settle',
      fails: 2,
      command: 'before the settle',
      checks: 3,
      stopped: 1
    },
    {
      check: ' fails twice and a command checks the leases once the settle is running',
      fails: 2,
      command: 'once the settle is running',
      checks: 3,
      stopped: 1
    }
  ] as const)(
    'settles an unlisted chat from what its recovery found when the lease check$check',
    async ({ fails, command, checks, stopped }) => {
      const rig = await newRig()
      const stopOwnerProcess = await crashWithLiveOwner(rig, ['session-listed', 'session-closed'])
      const listed = listedIds(rig)
      expect(listed).toEqual(['session-listed'])
      const reconcile = vi.spyOn(rig.store, 'reconcileOnRestart')
      for (let failure = 0; failure < fails; failure += 1) {
        reconcile.mockRejectedValueOnce(new Error('disk I/O error'))
      }
      // An attach the gate let through checks the leases first; what it answers does not matter.
      const attach = () => restTestChat(rig, 'session-listed').catch(() => undefined)

      await rig.host.reconcileRestartLeases()
      if (command === 'before the settle') {
        expect(rig.store.getRecord('session-closed')!.lease.unreconciled).toBe(true)
        await attach()
        expect(rig.store.getRecord('session-closed')!.lease.handoffStage).toBe('recovering')
      }
      const background = rig.host.startup.seedStoredStatuses(listed)
      // Owed: the crash cut its turn, so the settle opens it.
      expect(readUnsettledJournalSessionIds(db(rig))).toContain('session-closed')
      const settling = rig.host.startup.settleOwedSessions(listed)
      if (command === 'once the settle is running') {
        // The settle has waited on its recoveries and read its records.
        await new Promise((resolve) => setImmediate(resolve))
        expect(rig.store.getRecord('session-closed')!.lease.unreconciled).toBe(true)
        await attach()
      }
      await settling
      await rig.host.restoreReadableSessions(background)

      // No startup restore checks the leases again; with no check that held, nothing is stopped
      // and the chat settles unverified.
      expect(reconcile).toHaveBeenCalledTimes(checks)
      expect(stopOwnerProcess).toHaveBeenCalledTimes(stopped)
      expect(readTestJournalSessionStatus(rig.root, 'session-closed')).toMatchObject({
        lifecycle: 'idle',
        summary: { turnOutcome: stopped ? 'interruption' : 'unconfirmed' }
      })
      expect(rig.store.getRecord('session-closed')!.lease).toMatchObject(
        stopped ? { deathEvidence: { kind: 'pid-absent' } } : { unreconciled: true }
      )
      expect(rig.host.hasSession('session-closed')).toBe(false)
    }
  )
})

/** Chats whose turn was running when Orca died; the first is listed. The last one's provider
 *  process is still up until a stop ends it. */
async function crashWithLiveOwner(
  rig: RestTestRig,
  ids: readonly string[]
): Promise<ReturnType<typeof vi.fn>> {
  const leases: AgentSessionRecord['lease'][] = []
  for (const [index, sessionId] of ids.entries()) {
    await crashRestTestChatMidTurn(rig, sessionId, { listed: index === 0 })
    leases.push(rig.store.getRecord(sessionId)!.lease)
  }
  await rig.crash()
  for (const lease of leases) {
    await writeOlderBuildLease(rig.root, lease.sessionId, { ...lease })
  }
  let alive = true
  const stopOwnerProcess = vi.fn(() => {
    alive = false
  })
  rig.probeOwner.mockImplementation(async (record) =>
    alive && record.sessionId === ids.at(-1)
      ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
      : { outcome: 'pid-absent' }
  )
  await rig.boot({ stopOwnerProcess })
  return stopOwnerProcess
}

describe('one awaited settle covers a chat whose tab closes meanwhile (R1T-4)', () => {
  it('settles a listed chat the listed worker skips because its tab closed', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-closing')
    await rig.crash()
    await rig.boot()
    const listed = listedIds(rig)
    expect(listed).toContain('session-closing')
    await rig.host.reconcileRestartLeases()
    rig.host.startup.seedStoredStatuses(listed)
    // The tab closes after the listing named it, before its settle runs.
    await rig.store.setSessionTabVisibility('session-closing', false)

    await rig.host.startup.settleOwedSessions(listed)

    expect(readTestJournalSessionStatus(rig.root, 'session-closing')).toMatchObject({
      lifecycle: 'idle',
      handedOverSends: 0
    })
    expect(rig.host.hasSession('session-closing')).toBe(false)
  })
})

describe('commands held for the real startup settle never deadlock it (R2T-1)', () => {
  const CEILING_MS = 3_000

  it('holds a command issued before the settle, lets it, one during it and a healthy read through as the settle ends', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rig = await newRig()
    for (const sessionId of ['session-a', 'session-b']) {
      await crashRestTestChatMidTurn(rig, sessionId)
    }
    await restTestChat(rig, 'session-healthy', { message: 'fine' })
    await rig.crash()
    const gate = new StructuredAgentSessionStartupGate(CEILING_MS)
    gate.hold()
    await rig.boot({ commandsReady: gate.ready })
    const listed = listedIds(rig)
    await rig.host.reconcileRestartLeases()
    rig.host.startup.seedStoredStatuses(listed)
    expect(readUnsettledJournalSessionIds(db(rig)).toSorted()).toEqual(['session-a', 'session-b'])
    const started = Date.now()
    const elapsed = () => Date.now() - started
    const dispatched = rig.adapter.dispatch.mock.calls.length

    // Before the settle: a send to a crashed chat, and the option read a chat pane fires on mount.
    let sendAnswered = false
    const sendBefore = sendRestTestMessage(rig, 'session-a', 'during startup').then((result) => {
      sendAnswered = true
      expect(result).toMatchObject({ ok: true })
      return elapsed()
    })
    const optionsBefore = rig.host.readOptions('session-a').then(elapsed)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Held, neither answered nor dispatched; the tab list and the seeded status answer meanwhile.
    expect(sendAnswered).toBe(false)
    expect(rig.adapter.dispatch.mock.calls.length).toBe(dispatched)
    expect(listedIds(rig)).toContain('session-healthy')
    expect(latestRestTestStatus(rig, 'session-healthy')).toMatchObject({ status: 'idle' })
    const settled = rig.host.startup.settleOwedSessions(listed)
    gate.openWhen(settled)
    // During the settle: the second crashed chat, which the settle has not reached yet.
    const optionsDuring = rig.host.readOptions('session-b').then(elapsed)
    const healthyRead = rig.host.journalSnapshot('session-healthy').then(elapsed)
    const settleEnded = await settled.then(elapsed)

    const answered = await Promise.all([sendBefore, optionsBefore, optionsDuring, healthyRead])
    expect(settleEnded).toBeLessThan(CEILING_MS / 2)
    for (const at of answered) {
      expect(at).toBeLessThan(CEILING_MS / 2)
    }
    expect(gate.ready()).toBeNull()
    await vi.waitFor(() =>
      expect(rig.adapter.dispatch.mock.calls.length).toBeGreaterThan(dispatched)
    )
  }, 20_000)

  it('holds a rewind and a /clear sent straight to the host, and a read, then answers them as the settle ends', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rig = await newRig()
    const crashed = ['session-a', 'session-b', 'session-c']
    for (const sessionId of crashed) {
      await crashRestTestChatMidTurn(rig, sessionId)
    }
    await rig.crash()
    const gate = new StructuredAgentSessionStartupGate(CEILING_MS)
    gate.hold()
    await rig.boot({ commandsReady: gate.ready })
    const listed = listedIds(rig)
    await rig.host.reconcileRestartLeases()
    rig.host.startup.seedStoredStatuses(listed)
    const opensAtBoot = crashed.map((id) => restTestOpens(rig, id))
    const started = Date.now()
    const elapsed = () => Date.now() - started

    // Neither takes the RPC's reveal first; /clear is on the chat the settle reaches last.
    const rewind = rig.host
      .rewind(REST_TEST_CALLER, rewindParams('session-a', 'missing-item'))
      .then(elapsed, elapsed)
    const clear = rig.host
      .conversationCommand(REST_TEST_CALLER, conversationCommandParams('session-b', 'clear'))
      .then(elapsed, elapsed)
    // A read opens a closed chat too, which would settle it ahead of the lease resolution.
    const read = rig.host.journalSnapshot('session-c').then(elapsed)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Held: none has opened its crashed chat ahead of the settle.
    expect(crashed.map((id) => restTestOpens(rig, id))).toEqual(opensAtBoot)
    const settled = rig.host.startup.settleOwedSessions(listed)
    gate.openWhen(settled)
    const settleEnded = await settled.then(elapsed)

    expect(settleEnded).toBeLessThan(CEILING_MS / 2)
    for (const at of await Promise.all([rewind, clear, read])) {
      expect(at).toBeGreaterThanOrEqual(20)
      expect(at).toBeLessThan(CEILING_MS / 2)
    }
  }, 20_000)
})

function rewindParams(sessionId: string, itemId: string) {
  return {
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId,
        fields: { itemId, expectedEpoch: 'epoch-unknown' }
      })
    },
    itemId,
    expectedEpoch: 'epoch-unknown'
  }
}

function conversationCommandParams(sessionId: string, command: 'clear') {
  return {
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId,
        fields: { command }
      })
    },
    command
  }
}

describe('a listed chat whose recovery never answers', () => {
  it.each([
    ['its stored status, through the settle', true],
    ['no stored status, through the restore after the listing', false]
  ])(
    'is opened unverified with %s, with no second recovery beside the first, and the rest still settle',
    async (_path, rowed) => {
      const rig = await newRig()
      await crashMidSend(rig, 'session-stuck')
      await crashMidSend(rig, 'session-closed', false)
      const lease = rig.store.getRecord('session-stuck')!.lease
      await rig.crash()
      if (!rowed) {
        db(rig)
          .prepare('DELETE FROM journal_session_state WHERE session_id = ?')
          .run('session-stuck')
      }
      // Its provider process was up when Orca died; the check of it answers once, then never again.
      await writeOlderBuildLease(rig.root, 'session-stuck', { ...lease })
      let answered = false
      let hung = 0
      rig.probeOwner.mockImplementation(async (record) => {
        if (record.sessionId !== 'session-stuck') {
          return { outcome: 'pid-absent' }
        }
        if (!answered) {
          answered = true
          return { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        }
        hung += 1
        return new Promise(() => {})
      })
      await rig.boot({ startupRecoveryBudgetMs: 50 })
      expect(listedIds(rig)).toEqual(['session-stuck'])
      const warn = vi.spyOn(rig.host.deps.logger, 'warn')

      let background: string[] = []
      const done = await Promise.race([
        runRestTestStartup(rig).then((left) => {
          background = left
          return 'done'
        }),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5_000))
      ])

      expect(done).toBe('done')
      expect(background).toEqual(rowed ? [] : ['session-stuck'])
      expect(rig.host.hasSession('session-stuck')).toBe(true)
      expect(hung).toBe(1)
      expect(rig.store.getRecord('session-stuck')!.lease.handoffStage).toBe('recovering')
      expect(warn).toHaveBeenCalledWith('a chat recovery outlasted startup; left unverified', {
        scope: 'startup-recovery-timeout',
        sessionId: 'session-stuck'
      })
      expect(opened(rig, ['session-closed'])).toEqual(['session-closed'])
      expect(readTestJournalSessionStatus(rig.root, 'session-closed')).toMatchObject({
        lifecycle: 'idle'
      })
    },
    20_000
  )
})

describe('a stored status no settle here can clear (R2A-4)', () => {
  it('drops the row of a chat whose record is gone, so the next boot selects it no more', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-gone', false)
    await rig.crash()
    await editPersistedTestAgentSessionStore(rig.root, (persisted) => {
      delete persisted.records['session-gone']
    })

    await rig.boot()
    await runRestTestStartup(rig)

    expect(readTestJournalSessionStatus(rig.root, 'session-gone')).toBeNull()
    expect(opened(rig, ['session-gone'])).toEqual([])

    // The obligation died: the next boot finds no row to select and opens nothing.
    await rig.crash()
    await rig.boot()
    await runRestTestStartup(rig)
    expect(readTestJournalSessionStatus(rig.root, 'session-gone')).toBeNull()
    expect(opened(rig, ['session-gone'])).toEqual([])
  })
})
