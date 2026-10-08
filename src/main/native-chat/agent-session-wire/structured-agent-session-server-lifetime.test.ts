import { expect, it, vi } from 'vitest'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'

it('defers an automatic stop across an accepted send, provider handover, and Stop settlement', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    const held = Promise.withResolvers<void>()
    const queued = rig.host.collaboratorsForTests().serialize(HOST_TEST_SESSION, () => held.promise)
    const sending = rig.send('accepted behind the lock')
    const commit = vi.fn(() => true)
    expect(rig.host.serverRetirement.admitStop(commit)).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    held.resolve()
    await queued
    await sending.result
    await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalled())
    expect(rig.host.serverRetirement.read()).toBeGreaterThan(0)
    expect(rig.host.serverRetirement.admitStop(commit)).toBe(false)
    const stopping = rig.stop()
    expect(rig.host.serverRetirement.admitStop(commit)).toBe(false)
    await stopping
  } finally {
    await rig.dispose()
  }
})

it('closes admission atomically when an idle host commits an automatic stop', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    await vi.waitFor(() => expect(rig.host.serverRetirement.read()).toBe(0))
    expect(rig.host.serverRetirement.admitStop(() => true)).toBe(true)
    await expect(rig.send('raced the stop').result).rejects.toMatchObject({
      message: 'agent_session_ownership_unknown'
    })
    expect(rig.dispatch).not.toHaveBeenCalled()
  } finally {
    await rig.dispose()
  }
})

it('keeps admission open when a stop loses its decision to cancellation', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    await vi.waitFor(() => expect(rig.host.serverRetirement.read()).toBe(0))
    expect(rig.host.serverRetirement.admitStop(() => false)).toBe(false)
    await expect(rig.send('still usable').result).resolves.toMatchObject({ ok: true })
  } finally {
    await rig.dispose()
  }
})

it('treats an unreadable host journal as unknown and never invokes an automatic stop', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    vi.spyOn(rig.store, 'listRecords').mockImplementation(() => {
      throw new Error('unreadable')
    })
    const commit = vi.fn(() => true)
    expect(rig.host.serverRetirement.read()).toBeNull()
    expect(rig.host.serverRetirement.admitStop(commit)).toBe(false)
    expect(commit).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    await rig.dispose()
  }
})

it('rechecks an unknown prior owner so proven exit ends its retirement obligation', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    const owner = rig.store.getRecord(HOST_TEST_SESSION)?.lease.ownerProcess
    expect(owner).toBeTruthy()
    await rig.stop()
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
      ...record,
      lease: {
        ...record.lease,
        ownerProcess: owner ?? null,
        claimStatus: 'conflicted',
        handoffStage: 'recovering',
        deathEvidence: null
      }
    }))
    rig.host.deps.probeOwner = async () => ({ outcome: 'indeterminate', reason: 'unreachable' })
    expect(await rig.host.serverRetirement.observe()).toBeNull()
    expect(rig.host.serverRetirement.admitStop(() => true)).toBe(false)
    rig.host.deps.probeOwner = async () => ({ outcome: 'pid-absent' })
    await rig.host.serverRetirement.observe()
    await vi.waitFor(() => expect(rig.host.serverRetirement.read()).toBe(0))
    expect(rig.store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus).toBe('released')
    expect(rig.dispatch).not.toHaveBeenCalled()
  } finally {
    await rig.dispose()
  }
})
