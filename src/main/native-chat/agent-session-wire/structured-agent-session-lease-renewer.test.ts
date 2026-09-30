import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import { traceAgentSessionError } from '../../observability/agent-session-error-trace'

vi.mock('../../observability/agent-session-error-trace', () => ({
  traceAgentSessionError: vi.fn()
}))

const NOW = 1_800_000_000_000
const roots: string[] = []

async function liveStore(): Promise<AgentSessionRecordStore> {
  const root = await mkdtemp(join(tmpdir(), 'orca-lease-renewer-'))
  roots.push(root)
  const store = await openTestAgentSessionRecordStore(root)
  const reserved = await store.reserveOwner({
    sessionId: 'session-renewal',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: root },
    expectedFence: null,
    spawnToken: 'spawn-renewal',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'create'
    },
    now: NOW
  })
  await store.commitProcessIdentity({
    sessionId: 'session-renewal',
    fence: reserved.record.lease.runtimeFence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'spawn-renewal'
    },
    now: NOW
  })
  await store.proveOwner({
    sessionId: 'session-renewal',
    fence: reserved.record.lease.runtimeFence,
    link: {
      linkId: 'link-renewal',
      handle: { provider: 'codex', threadId: 'thread-renewal' },
      origin: 'created',
      mintedAtFence: reserved.record.lease.runtimeFence,
      observedAt: NOW
    },
    now: NOW
  })
  return store
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('structured agent-session lease renewal', () => {
  it('isolates renewal failures per live record', async () => {
    const records = ['a', 'b'].map((suffix, index) => {
      const sessionId = `session-${suffix}`
      return agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId,
          runtimeKind: 'native',
          runtimeFence: index + 1,
          ownerProcess: {
            hostId: 'local',
            pid: 4200 + index,
            processStartTimeMs: NOW - 1_000,
            spawnToken: `spawn-${suffix}`
          },
          reservedSpawnToken: `spawn-${suffix}`,
          lastRenewedAt: NOW,
          leaseDeadlineAt: NOW + 30_000
        })
      )
    })
    const renewLeases = vi.fn(async (renewals: readonly { sessionId: string }[]) =>
      renewals.map((renewal) => records.find((record) => record.sessionId === renewal.sessionId)!)
    )
    const probeMany = vi.fn(
      async () =>
        new Map(
          records.map((record) => [
            record.sessionId,
            { outcome: 'identity-matched', matchedOn: ['spawn-token'] } as const
          ])
        )
    )
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store: { listRecords: () => records, renewLeases } as unknown as AgentSessionRecordStore,
      probe: vi.fn(),
      probeMany,
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(probeMany).toHaveBeenCalledOnce()
    expect(renewLeases).toHaveBeenCalledOnce()
    expect(renewLeases.mock.calls[0]?.[0]).toHaveLength(2)
  })

  it('keeps a healthy lease alive when a sibling renewal is superseded', async () => {
    const records = ['a', 'b'].map((suffix, index) =>
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: `session-${suffix}`,
          runtimeKind: 'native',
          runtimeFence: index + 1,
          ownerProcess: {
            hostId: 'local',
            pid: 4200 + index,
            processStartTimeMs: NOW - 1_000,
            spawnToken: `spawn-${suffix}`
          },
          reservedSpawnToken: `spawn-${suffix}`,
          lastRenewedAt: NOW,
          leaseDeadlineAt: NOW + 30_000
        })
      )
    )
    const renewLeases = vi.fn(async () => {
      throw new Error('agent_session_checkpoint_stale')
    })
    const renewLease = vi.fn(async (renewal: { sessionId: string }) => {
      if (renewal.sessionId === 'session-b') {
        throw new Error('agent_session_checkpoint_stale')
      }
      return records[0]!
    })
    vi.mocked(traceAgentSessionError).mockClear()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store: {
        listRecords: () => records,
        renewLeases,
        renewLease
      } as unknown as AgentSessionRecordStore,
      probe: async () => ({
        outcome: 'identity-matched' as const,
        matchedOn: ['spawn-token' as const]
      }),
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(renewLeases).toHaveBeenCalledOnce()
    expect(renewLease).toHaveBeenCalledTimes(2)
    expect(traceAgentSessionError).toHaveBeenCalledExactlyOnceWith({
      step: 'lease-renewal',
      sessionId: 'session-b',
      error: expect.objectContaining({ message: 'agent_session_checkpoint_stale' })
    })
  })

  it('drives renewal on the production interval', async () => {
    vi.useFakeTimers()
    const store = await liveStore()
    let now = NOW
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({
        outcome: 'identity-matched',
        matchedOn: ['process-start-time']
      }),
      now: () => now
    })
    try {
      renewer.start()
      now += 10_000
      await vi.advanceTimersByTimeAsync(10_000)
      // Real-timer poll: the suite's default 1000ms budget is tight under a loaded CI shard.
      await vi.waitFor(
        () => expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(now),
        { timeout: 5000 }
      )
    } finally {
      await renewer.stop()
      vi.useRealTimers()
    }
  })

  it('stops only once a renewal already in flight has finished writing', async () => {
    const store = await liveStore()
    let releaseProbe = (): void => {}
    const probing = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => {
        await probing
        return { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
      },
      now: () => NOW + 10_000
    })

    void renewer.renewNow()
    // Nothing has been written yet: the tick is parked in its probe.
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    const stopped = renewer.stop()
    releaseProbe()
    await stopped

    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW + 10_000)
  })

  it('renews every live owner only after re-proving its child identity', async () => {
    const store = await liveStore()
    const probe = vi.fn(async () => ({
      outcome: 'identity-matched' as const,
      matchedOn: ['process-start-time' as const]
    }))
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe,
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(probe).toHaveBeenCalledOnce()
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW + 10_000)
  })

  it('stops extending the lease when child proof is no longer sufficient', async () => {
    const store = await liveStore()
    vi.mocked(traceAgentSessionError).mockClear()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({ outcome: 'indeterminate', reason: 'probe unavailable' }),
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    expect(traceAgentSessionError).toHaveBeenCalledWith({
      step: 'lease-renewal',
      sessionId: 'session-renewal',
      error: expect.any(Error)
    })
  })

  it('never extends the lease of a record parked in recovery', async () => {
    // The host cannot vouch for a child it holds no transport to; renewing while
    // recovering keeps an orphan pid's lease alive and reads as a healthy owner.
    const store = await liveStore()
    await store.transitionHandoff('session-renewal', (record) => ({
      ...record,
      lease: { ...record.lease, handoffStage: 'recovering' }
    }))
    const probe = vi.fn(async () => ({
      outcome: 'identity-matched' as const,
      matchedOn: ['process-start-time' as const]
    }))
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe,
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(probe).not.toHaveBeenCalled()
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
  })

  describe('a failure that repeats every tick', () => {
    function liveRecord(sessionId: string) {
      return agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId,
          runtimeKind: 'native',
          runtimeFence: 1,
          ownerProcess: {
            hostId: 'local',
            pid: 4200,
            processStartTimeMs: NOW - 1_000,
            spawnToken: 'spawn-a'
          },
          reservedSpawnToken: 'spawn-a',
          lastRenewedAt: NOW,
          leaseDeadlineAt: NOW + 30_000
        })
      )
    }

    /** Each tick's renewal throws whatever `failure` holds, or renews when it holds null. */
    async function stuckRenewer(
      sessionIds: string[],
      probe: () => Promise<AgentSessionOwnerProbe> = async () => ({
        outcome: 'identity-matched',
        matchedOn: ['spawn-token']
      })
    ) {
      const state: { failure: (() => Error) | null; records: string[] } = {
        failure: () => new Error('agent_session_ownership_unknown'),
        records: sessionIds
      }
      const store = await liveStore()
      vi.spyOn(store, 'listRecords').mockImplementation(() => state.records.map(liveRecord))
      vi.spyOn(store, 'renewLeases').mockRejectedValue(new Error('batch refused'))
      vi.spyOn(store, 'renewLease').mockImplementation(async (renewal) => {
        if (state.failure) {
          throw state.failure()
        }
        return liveRecord(renewal.sessionId)
      })
      const renewer = new StructuredAgentSessionLeaseRenewer({
        store,
        probe,
        now: () => NOW + 10_000
      })
      return { state, renewer }
    }

    async function ticks(renewer: StructuredAgentSessionLeaseRenewer, count: number) {
      for (let tick = 0; tick < count; tick += 1) {
        await renewer.renewNow()
      }
    }

    const renewalRecords = () =>
      vi
        .mocked(traceAgentSessionError)
        .mock.calls.filter(([report]) => report.step === 'lease-renewal')

    it('records it once, however many ticks it repeats', async () => {
      vi.mocked(traceAgentSessionError).mockClear()
      const { renewer } = await stuckRenewer(['session-a'])

      await ticks(renewer, 5)

      expect(renewalRecords()).toEqual([
        [
          {
            step: 'lease-renewal',
            sessionId: 'session-a',
            error: expect.objectContaining({ message: 'agent_session_ownership_unknown' })
          }
        ]
      ])
    })

    it('keys a store error on its code, not its per-attempt temp path', async () => {
      vi.mocked(traceAgentSessionError).mockClear()
      const { state, renewer } = await stuckRenewer(['session-a'])
      let attempt = 0
      state.failure = () =>
        Object.assign(
          new Error(`EACCES: permission denied, open 'records.${(attempt += 1)}.tmp'`),
          {
            code: 'EACCES'
          }
        )

      await ticks(renewer, 3)

      expect(renewalRecords()).toHaveLength(1)
    })

    it('records it again after the session renews, and when the failure changes', async () => {
      vi.mocked(traceAgentSessionError).mockClear()
      const { state, renewer } = await stuckRenewer(['session-a'])
      const unknown = state.failure

      await ticks(renewer, 2)
      state.failure = null
      await ticks(renewer, 1)
      state.failure = unknown
      await ticks(renewer, 2)
      expect(renewalRecords()).toHaveLength(2)

      state.failure = () => new Error('agent_session_checkpoint_stale')
      await ticks(renewer, 2)
      expect(renewalRecords().map(([report]) => String(report.error))).toEqual([
        'Error: agent_session_ownership_unknown',
        'Error: agent_session_ownership_unknown',
        'Error: agent_session_checkpoint_stale'
      ])
    })

    it('forgets a session that stops being renewable', async () => {
      vi.mocked(traceAgentSessionError).mockClear()
      const { state, renewer } = await stuckRenewer(['session-a'])

      await ticks(renewer, 1)
      state.records = []
      await ticks(renewer, 1)
      state.records = ['session-a']
      await ticks(renewer, 1)

      expect(renewalRecords()).toHaveLength(2)
    })

    it('records a probe that keeps failing once', async () => {
      vi.mocked(traceAgentSessionError).mockClear()
      const { renewer } = await stuckRenewer(['session-a'], async () => {
        throw new Error('probe unavailable')
      })

      await ticks(renewer, 3)

      expect(
        vi
          .mocked(traceAgentSessionError)
          .mock.calls.filter(([report]) => report.step === 'lease-probe')
      ).toHaveLength(1)
    })
  })
})
