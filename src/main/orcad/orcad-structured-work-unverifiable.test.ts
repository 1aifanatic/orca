import { expect, it, vi } from 'vitest'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore
} from '../runtime/agent-session-record-store-test-harness'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { prepareOrcadStructuredWorkBoundary } from './orcad-structured-work-boundary'

it.each(['live', 'unverifiable'] as const)(
  'preserves a %s native owner during passive observation',
  async (verdict) => {
    const rig = await createQueuedMessageTestRig()
    try {
      const saved = rig.store.getRecord(HOST_TEST_SESSION)
      if (!saved?.lease.ownerProcess) {
        throw new Error('owner missing')
      }
      await rig.stop()
      await rig.host.close(HOST_TEST_SESSION, 'evict')
      await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
        ...record,
        lease: { ...saved.lease, handoffStage: 'recovering', deathEvidence: null }
      }))
      rig.host.deps.probeOwner = async () =>
        verdict === 'live'
          ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
          : { outcome: 'indeterminate', reason: 'probe unavailable' }
      const stop = vi.fn()
      rig.host.deps.stopOwnerProcess = stop
      expect(rig.host.serverRetirement.read()).toBeNull()
      await rig.host.serverRetirement.observe()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect({
        claimStatus: rig.store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus,
        work: rig.host.serverRetirement.read(),
        admitted: rig.host.serverRetirement.admitStop(() => true)
      }).toEqual({ claimStatus: 'live', work: null, admitted: false })
      expect(stop).not.toHaveBeenCalled()
      rig.host.deps.probeOwner = async () => ({ outcome: 'pid-absent' })
      await rig.host.serverRetirement.observe()
      await vi.waitFor(() => expect(rig.host.serverRetirement.read()).toBe(0))
      expect(rig.store.getRecord(HOST_TEST_SESSION)?.lease).toMatchObject({
        ownerProcess: null,
        deathEvidence: { kind: 'pid-absent' }
      })
    } finally {
      await rig.dispose()
    }
  }
)

it('retains an unknown native owner across startup and readable restore until positive exit proof', async () => {
  const rig = await createQueuedMessageTestRig()
  const previous = getStructuredAgentSessionHost()
  let restarted: StructuredAgentSessionHost | undefined
  try {
    const saved = rig.store.getRecord(HOST_TEST_SESSION)
    if (!saved?.lease.ownerProcess) {
      throw new Error('owner missing')
    }
    await rig.stop()
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
      ...record,
      lease: saved.lease
    }))
    const store = await openTestAgentSessionRecordStore(rig.root)
    expect(store.getRecord(HOST_TEST_SESSION)?.lease.unreconciled).toBe(true)
    const stop = vi.fn()
    restarted = new StructuredAgentSessionHost({
      ...rig.host.deps,
      store,
      probeOwner: async () => ({ outcome: 'indeterminate', reason: 'probe unavailable' }),
      stopOwnerProcess: stop
    })
    setStructuredAgentSessionHost(restarted)
    await prepareOrcadStructuredWorkBoundary({ ensureStructuredAgentSessionHost: async () => {} })
    await restarted.restoreReadableSessions()
    expect(store.getRecord(HOST_TEST_SESSION)?.lease).toMatchObject({
      ownerProcess: saved.lease.ownerProcess,
      handoffStage: 'recovering',
      deathEvidence: null
    })
    expect(restarted.serverRetirement.read()).toBeNull()
    expect(restarted.serverRetirement.admitStop(() => true)).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    restarted.deps.probeOwner = async () => ({ outcome: 'pid-absent' })
    await restarted.serverRetirement.observe()
    const retirement = restarted.serverRetirement
    await vi.waitFor(() => expect(retirement.read()).toBe(0))
  } finally {
    setStructuredAgentSessionHost(previous)
    await restarted?.flushAllStreamedEvents()
    await rig.dispose()
  }
})

it('treats a quarantined unreadable session record as unverifiable for retirement', async () => {
  const rig = await createQueuedMessageTestRig()
  let restarted: StructuredAgentSessionHost | undefined
  try {
    await editPersistedTestAgentSessionStore(rig.root, (persisted) => {
      Object.assign(persisted.records[HOST_TEST_SESSION].lease, { provenHandleLinkId: null })
    })
    const store = await openTestAgentSessionRecordStore(rig.root)
    expect(store.isSessionUnreadable(HOST_TEST_SESSION)).toBe(true)
    expect(store.readOnly).toBe(false)
    expect(store.listRecords()).toEqual([])
    restarted = new StructuredAgentSessionHost({ ...rig.host.deps, store })
    expect({
      work: restarted.serverRetirement.read(),
      admitted: restarted.serverRetirement.admitStop(() => true)
    }).toEqual({ work: null, admitted: false })
  } finally {
    await restarted?.flushAllStreamedEvents()
    await rig.dispose()
  }
})
