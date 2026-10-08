import { expect, it, vi } from 'vitest'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestOperationId
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { STRUCTURED_AGENT_SESSION_OWNERLESS_RESERVATION_MAX_AGE_MS as MAX_AGE } from '../native-chat/agent-session-wire/structured-agent-session-reservation-retirement'
import { createStructuredAgentSessionOwnerProbe } from '../runtime/structured-agent-session-owner-probe'
import {
  findAgentSessionSpawnTokenProcesses,
  scanAgentSessionSpawnTokenProcesses
} from '../runtime/agent-session-spawn-token-process-scan'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'

async function reservationRig(platform: NodeJS.Platform) {
  const rig = await createQueuedMessageTestRig()
  await rig.stop()
  await rig.host.close(HOST_TEST_SESSION, 'evict')
  const id = 'ownerless-reservation'
  const reservedAt = HOST_TEST_NOW
  const scan = vi.fn(() =>
    platform === 'linux' ? Promise.resolve(null) : scanAgentSessionSpawnTokenProcesses(platform)
  )
  rig.host.deps.platform = platform
  rig.host.deps.now = () => reservedAt
  rig.host.deps.probeOwner = createStructuredAgentSessionOwnerProbe(
    rig.store.hostId,
    undefined,
    (token) => findAgentSessionSpawnTokenProcesses(token, scan)
  )
  await rig.store.reserveOwner({
    sessionId: id,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: rig.root },
    expectedFence: null,
    spawnToken: 'unverifiable-reservation',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: hostTestOperationId(),
      fingerprint: 'create-reservation'
    },
    now: reservedAt
  })
  await rig.host.reconcileRestartLeases()
  return { ...rig, id, reservedAt, scan }
}

it.each(['darwin', 'win32'] as const)(
  'bounds automatic retirement on an unheld %s reservation without declaring exit',
  async (platform) => {
    const rig = await reservationRig(platform)
    try {
      rig.host.deps.now = () => rig.reservedAt + MAX_AGE - 1
      expect(await rig.host.serverRetirement.observe()).toBeNull()
      expect(rig.host.serverRetirement.admitStop(() => true)).toBe(false)
      rig.host.deps.now = () => rig.reservedAt + MAX_AGE
      expect(await rig.host.serverRetirement.observe()).toBe(0)
      expect(rig.scan).toHaveBeenCalled()
      expect(rig.store.getRecord(rig.id)?.lease).toMatchObject({
        claimStatus: 'reserved',
        reservedSpawnToken: 'unverifiable-reservation',
        ownerProcess: null,
        deathEvidence: null
      })
      const held = Promise.withResolvers<void>()
      const operation = rig.host.collaboratorsForTests().serialize(rig.id, () => held.promise)
      expect(rig.host.serverRetirement.admitStop(() => true)).toBe(false)
      held.resolve()
      await operation
      expect(rig.host.serverRetirement.admitStop(() => true)).toBe(true)
    } finally {
      await rig.dispose()
    }
  }
)

it.each(['darwin', 'win32'] as const)(
  'records deliberate abandonment of an ownerless %s reservation across restart',
  async (platform) => {
    const rig = await reservationRig(platform)
    try {
      const fence = rig.store.getRecord(rig.id)?.lease.runtimeFence
      await rig.host.serverRetirement.abandonOwnerlessReservations()
      const reopened = await openTestAgentSessionRecordStore(rig.root)
      await reopened.reconcileOnRestart({
        probe: async () => ({ outcome: 'indeterminate', reason: 'scan unavailable' }),
        now: rig.reservedAt
      })
      expect(reopened.getRecord(rig.id)?.lease).toMatchObject({
        claimStatus: 'released',
        reservedSpawnToken: null,
        ownerProcess: null,
        handoffStage: null,
        deathEvidence: null
      })
      expect(reopened.getRecord(rig.id)?.lease.runtimeFence).toBe((fence ?? 0) + 1)
    } finally {
      await rig.dispose()
    }
  }
)

it('keeps Linux scan proof and named owners outside the ownerless retirement deadline', async () => {
  const rig = await reservationRig('linux')
  try {
    rig.host.deps.now = () => rig.reservedAt + MAX_AGE
    expect(await rig.host.serverRetirement.observe()).toBeNull()
    expect(rig.host.serverRetirement.admitStop(() => true)).toBe(false)
  } finally {
    await rig.dispose()
  }
  const owned = await createQueuedMessageTestRig()
  try {
    const lease = owned.store.getRecord(HOST_TEST_SESSION)?.lease
    await owned.host.serverRetirement.abandonOwnerlessReservations()
    expect(owned.store.getRecord(HOST_TEST_SESSION)?.lease).toEqual(lease)
  } finally {
    await owned.dispose()
  }
})

it('never expires or abandons an unheld named owner on Windows', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    const saved = rig.store.getRecord(HOST_TEST_SESSION)?.lease
    if (!saved?.ownerProcess) {
      throw new Error('owner missing')
    }
    await rig.stop()
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
      ...record,
      lease: { ...saved, handoffStage: 'recovering' }
    }))
    rig.host.deps.platform = 'win32'
    rig.host.deps.now = () => saved.lastRenewedAt + MAX_AGE
    rig.host.deps.probeOwner = async () => ({
      outcome: 'indeterminate',
      reason: 'scan unavailable'
    })
    expect(await rig.host.serverRetirement.observe()).toBeNull()
    expect(rig.host.serverRetirement.admitStop(() => true)).toBe(false)
    await rig.host.serverRetirement.abandonOwnerlessReservations()
    expect(rig.store.getRecord(HOST_TEST_SESSION)?.lease).toMatchObject({
      ownerProcess: saved.ownerProcess,
      claimStatus: 'live',
      deathEvidence: null
    })
  } finally {
    await rig.dispose()
  }
})
