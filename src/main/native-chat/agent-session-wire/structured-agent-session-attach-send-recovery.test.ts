import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
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
  const sends = []
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
    const resolve = AgentSessionJournal.prototype.resolveDispatch
    const error = Object.assign(new Error('earlier send settlement failed'), {
      code: 'SQLITE_BUSY'
    })
    const writes = vi.spyOn(AgentSessionJournal.prototype, 'resolveDispatch')
    writes.mockImplementation(function (this: AgentSessionJournal, input, hook) {
      if (input.recovered && input.state === state) {
        return Promise.reject(error)
      }
      return resolve.call(this, input, hook)
    })

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
    expect(logging.entries).toContainEqual({
      level: 'warn',
      message: 'settling earlier sends against provider history failed',
      fields: { scope: 'attach-send-reconcile', sessionId: SESSION, error }
    })
    expect(await rig.host.send(CALLER, send!)).toMatchObject({ ok: true, replayed: true })
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)

    writes.mockRestore()
    if (state === 'rejected') {
      // A live child's history cannot prove absence; wait for the next safe sampling boundary.
      expect(await rig.host.attach(CALLER, resumeParams)).toMatchObject({
        ok: true,
        value: { unconfirmedClientMessageIds: [clientMessageId] }
      })
      expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    }
    await crashRestart()
    expect(await resume()).toMatchObject({ ok: true, value: { unconfirmedClientMessageIds: [] } })
    expect((await rig.host.journalSnapshot(SESSION)).submissions[0]?.dispatchState).toBe(state)
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)
  }
)
