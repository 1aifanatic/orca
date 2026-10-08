import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { replayJournal } from '../agent-session-journal/journal-open'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  acceptedDispatch,
  createRestTestRig,
  restTestSend,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD as THREAD,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

let rig: RestTestRig
let logging: ReturnType<typeof recordingStructuredAgentSessionLogger>
let history: ProviderHistoryWindow
let ownerLive = false
let resumeParams: AgentSessionAttachParams
const retired: StructuredAgentSessionHost[] = []
const settlementError = Object.assign(new Error('earlier send settlement failed'), {
  code: 'SQLITE_BUSY'
})

beforeEach(async () => {
  logging = recordingStructuredAgentSessionLogger()
  history = { items: [], boundaryConsistent: true, turnInFlight: false }
  ownerLive = false
  rig = await createRestTestRig({
    logger: logging.logger,
    probeOwner: async () =>
      ownerLive
        ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        : { outcome: 'pid-absent' },
    idleSweep: { intervalMs: 3_600_000 }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(retired.splice(0).map((host) => host.flushAllStreamedEvents()))
  await rig.dispose()
})

async function crashRestart(): Promise<void> {
  ownerLive = false
  retired.push(rig.host)
  rig.store = await openTestAgentSessionRecordStore(rig.root)
  rig.host = new StructuredAgentSessionHost({
    ...rig.host.deps,
    store: rig.store,
    adapter: { ...rig.host.deps.adapter, providerHistoryWindow: async () => history }
  })
  await rig.host.reconcileRestartLeases()
}

async function crashWithSends(count: number) {
  const attached = await rig.host.attach(CALLER, hostTestAttachParams(null))
  if (!attached.ok) {
    throw new Error(attached.refusal.message)
  }
  rig.adapter.dispatch.mockResolvedValue({ state: 'admitted' })
  const sends: ReturnType<typeof restTestSend>[] = []
  for (let index = 0; index < count; index += 1) {
    const send = restTestSend(`message ${index}`, attached.fence)
    expect(await rig.host.send(CALLER, send)).toMatchObject({ ok: true })
    sends.push(send)
  }
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(count))
  await crashRestart()
  return sends
}

function acceptedHistory(clientMessageIds: string[]): ProviderHistoryWindow {
  return {
    boundaryConsistent: true,
    turnInFlight: false,
    items: clientMessageIds.map((clientMessageId, ordinal) => ({
      clientMessageId,
      providerItemId: `item-${ordinal}`,
      payloadFingerprint: null,
      identity: { provider: 'codex', threadId: THREAD, turnId: 'old', ordinal }
    }))
  }
}

/** The next recovered `state` verdict fails inside its own SQLite transaction, once: the INSERT
 *  runs and the real rollback undoes it. */
function failNextSettlementWrite(state: 'accepted' | 'rejected'): void {
  const connection = openTestJournalHostDatabase(rig.root).db
  const prepare = connection.prepare.bind(connection)
  let armed = true
  // The database caches statements, so each is wrapped once.
  const wrapped = new WeakSet<object>()
  vi.spyOn(connection, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql)
    if (!sql.startsWith('INSERT INTO journal_rows') || wrapped.has(statement)) {
      return statement
    }
    wrapped.add(statement)
    const run = statement.run.bind(statement)
    vi.spyOn(statement, 'run').mockImplementation((...params) => {
      const result = run(...params)
      const json = params.at(-1)
      const parsed = typeof json === 'string' ? parseJournalRow(json) : null
      if (
        armed &&
        parsed?.ok &&
        parsed.row.kind === 'dispatch' &&
        parsed.row.recovered === true &&
        parsed.row.state === state
      ) {
        armed = false
        throw settlementError
      }
      return result
    })
    return statement
  })
}

/** What a fresh process would read: the committed rows on disk, not this host's memory. */
function dispatchStateOnDisk(clientMessageId: string): string | undefined {
  const disk = new Database(journalDatabasePath(rig.root), { readonly: true })
  try {
    return replayJournal(disk, SESSION)?.state.submissions.get(clientMessageId)?.dispatchState
  } finally {
    disk.close()
  }
}

async function resume() {
  resumeParams = hostTestAttachParams(rig.store.getRecord(SESSION)!.lease.runtimeFence)
  const result = await rig.host.attach(CALLER, resumeParams)
  ownerLive = result.ok
  return result
}

it.each(['accepted', 'rejected'] as const)(
  'resumes when persisting an earlier send as %s fails, without resending it',
  async (state) => {
    const [send] = await crashWithSends(1)
    const clientMessageId = send!.envelope.clientOperationId
    if (state === 'accepted') {
      history = acceptedHistory([clientMessageId])
    }
    failNextSettlementWrite(state)

    const attached = await resume()

    expect(attached, JSON.stringify(attached)).toMatchObject({
      ok: true,
      value: { unconfirmedClientMessageIds: [clientMessageId] }
    })
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect((await rig.host.journalSnapshot(SESSION)).submissions[0]).toMatchObject({
      dispatchState: 'unknown'
    })
    expect(dispatchStateOnDisk(clientMessageId)).toBe('unknown')
    expect(logging.entries).toContainEqual({
      level: 'warn',
      message: 'settling earlier sends against provider history failed',
      fields: { scope: 'attach-send-reconcile', sessionId: SESSION, error: settlementError }
    })
    expect(await rig.host.send(CALLER, send!)).toMatchObject({ ok: true, replayed: true })
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)

    await crashRestart()
    // Presence still decides it; absence no longer can, since the owner that resume started
    // could have moved where the history starts past it.
    const still = state === 'accepted' ? [] : [clientMessageId]
    expect(await resume()).toMatchObject({
      ok: true,
      value: { unconfirmedClientMessageIds: still }
    })
    expect((await rig.host.journalSnapshot(SESSION)).submissions[0]?.dispatchState).toBe(
      state === 'accepted' ? 'accepted' : 'unknown'
    )
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)
  }
)

it('keeps a delivered send unconfirmed after a later turn moves the history past it', async () => {
  const [send] = await crashWithSends(1)
  const clientMessageId = send!.envelope.clientOperationId
  history = acceptedHistory([clientMessageId])
  failNextSettlementWrite('accepted')
  expect(await resume()).toMatchObject({
    ok: true,
    value: { unconfirmedClientMessageIds: [clientMessageId] }
  })

  // The user keeps chatting; that turn ends, and the resume point now sits past both messages.
  rig.adapter.dispatch.mockResolvedValueOnce(acceptedDispatch())
  const next = restTestSend('after the restart', rig.store.getRecord(SESSION)!.lease.runtimeFence)
  expect(await rig.host.send(CALLER, next)).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
  history = { items: [], boundaryConsistent: true, turnInFlight: false }

  await crashRestart()

  // Absent only because the history now starts after it: calling it undelivered would offer a
  // Retry that sends it twice.
  expect(await resume()).toMatchObject({
    ok: true,
    value: { unconfirmedClientMessageIds: [clientMessageId] }
  })
  const submissions = (await rig.host.journalSnapshot(SESSION)).submissions
  expect(submissions.map((entry) => [entry.clientMessageId, entry.dispatchState])).toEqual([
    [clientMessageId, 'unknown'],
    [next.envelope.clientOperationId, 'accepted']
  ])
  expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2)
})

it('keeps the running agent when saving an earlier send fails on re-attach', async () => {
  const [send] = await crashWithSends(1)
  const clientMessageId = send!.envelope.clientOperationId
  // The first resume cannot decide it, so the send outlives that attach unconfirmed.
  history = { items: [], boundaryConsistent: false, turnInFlight: false }
  expect(await resume()).toMatchObject({
    ok: true,
    value: { unconfirmedClientMessageIds: [clientMessageId] }
  })
  const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
  history = acceptedHistory([clientMessageId])
  failNextSettlementWrite('accepted')

  expect(await rig.host.attach(CALLER, resumeParams)).toMatchObject({
    ok: true,
    value: { fence, unconfirmedClientMessageIds: [clientMessageId] }
  })

  expect(logging.scopes()).toContain('attach-send-reconcile')
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  expect(rig.host.deps.adapter.releaseAcquisition).not.toHaveBeenCalled()
  expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
  expect(rig.store.getRecord(SESSION)?.lease).toMatchObject({
    claimStatus: 'live',
    runtimeFence: fence
  })
  expect(dispatchStateOnDisk(clientMessageId)).toBe('unknown')
})
