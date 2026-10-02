import { describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from './agent-session-lease-adjudication'
import {
  agentSessionLeaseAdmitsWriter,
  agentSessionLeaseFreeEvidence,
  agentSessionLeaseIsFree,
  agentSessionLeaseOwnerVerdict,
  deriveAgentSessionLeaseState,
  type AgentSessionHostProof,
  type AgentSessionOwnerEvidence
} from './agent-session-lease-state'
import type { AgentSessionLease } from './agent-session-record'

const OWNER = {
  hostId: 'local',
  pid: 4242,
  processStartTimeMs: 1_700_000_000_000,
  spawnToken: 'spawn-a'
}

function lease(overrides: Partial<AgentSessionLease> = {}): AgentSessionLease {
  return {
    sessionId: 'session-alpha-1',
    runtimeKind: 'native',
    runtimeFence: 7,
    handoffStage: null,
    provenHandleLinkId: 'link-1',
    ownerProcess: OWNER,
    reservedSpawnToken: 'spawn-a',
    leaseDeadlineAt: 1_000,
    lastRenewedAt: 500,
    handoffOperationId: null,
    journalCheckpoint: null,
    claimKeyId: 'key-1',
    claimStatus: 'live',
    unreconciled: false,
    deathEvidence: null,
    ...overrides
  }
}

function proof(owner: AgentSessionOwnerEvidence, fence = 7, attemptInFlight = false) {
  return { fence, attemptInFlight, owner } satisfies AgentSessionHostProof
}

const probed = (probe: AgentSessionOwnerProbe): AgentSessionOwnerEvidence => ({
  kind: 'probed',
  probe
})
const WATCHED: AgentSessionOwnerEvidence = { kind: 'watched-exit', observedAt: 900, reason: null }
const PID_ABSENT = probed({ outcome: 'pid-absent' })
const ALIVE = probed({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })
const INDETERMINATE = probed({ outcome: 'indeterminate', reason: 'owner on another host' })
const RESERVED = {
  ownerProcess: null,
  claimStatus: 'reserved',
  handoffStage: 'new-owner-proving',
  handoffOperationId: 'op-1'
} as const

describe('lease state derived from host proof', () => {
  it('frees a stored live lease whose owner this host watched exit or probed dead', () => {
    // The stranded case: the exit-time release write failed, the stored claim still says live.
    expect(deriveAgentSessionLeaseState(lease(), proof(WATCHED))).toEqual({
      state: 'free',
      basis: WATCHED
    })
    expect(deriveAgentSessionLeaseState(lease(), proof(PID_ABSENT)).state).toBe('free')
  })

  it('admits a writer only for the owner this host runs', () => {
    expect(
      agentSessionLeaseAdmitsWriter(deriveAgentSessionLeaseState(lease(), proof({ kind: 'runs' })))
    ).toBe(true)
    expect(agentSessionLeaseAdmitsWriter(deriveAgentSessionLeaseState(lease(), proof(ALIVE)))).toBe(
      false
    )
    expect(agentSessionLeaseAdmitsWriter(deriveAgentSessionLeaseState(lease(), null))).toBe(false)
  })

  it.each([
    [
      'conflicted, even with proof of death',
      lease({ claimStatus: 'conflicted' }),
      PID_ABSENT,
      'conflicted'
    ],
    [
      'unreconciled, even with proof of death',
      lease({ unreconciled: true }),
      WATCHED,
      'reconciling'
    ],
    [
      'recovering, even with proof of death',
      lease({ handoffStage: 'recovering' }),
      PID_ABSENT,
      'recovering'
    ],
    ['proven alive', lease(), ALIVE, 'held'],
    ['unverifiable, including an owner on another host', lease(), INDETERMINATE, 'unverifiable'],
    ['nothing proven at all', lease(), { kind: 'none' }, 'unverifiable'],
    ['a reservation nothing proves unused', lease(RESERVED), INDETERMINATE, 'unverifiable']
  ] as const)('never frees a lease that is %s', (_label, stored, owner, expected) => {
    const state = deriveAgentSessionLeaseState(stored, proof(owner))
    expect(state.state).toBe(expected)
    expect(agentSessionLeaseIsFree(state)).toBe(false)
  })

  it('ignores proof gathered at another fence', () => {
    expect(deriveAgentSessionLeaseState(lease(), proof(WATCHED, 6)).state).toBe('unverifiable')
    expect(deriveAgentSessionLeaseState(lease(), proof({ kind: 'runs' }, 8)).state).toBe(
      'unverifiable'
    )
  })

  it("frees an abandoned reservation only on the token scan's proof", () => {
    expect(
      deriveAgentSessionLeaseState(
        lease(RESERVED),
        proof(probed({ outcome: 'reservation-unused' }))
      ).state
    ).toBe('free')
    expect(
      deriveAgentSessionLeaseState(lease({ ...RESERVED, ownerProcess: OWNER }), proof(PID_ABSENT))
        .state
    ).toBe('free')
  })

  it('reads an acquisition this host has in flight as acquiring, never unverifiable', () => {
    for (const stored of [lease(), lease(RESERVED), lease({ claimStatus: 'released' })]) {
      const state = deriveAgentSessionLeaseState(stored, proof({ kind: 'none' }, 7, true))
      expect(state).toEqual({ state: 'acquiring' })
      expect(agentSessionLeaseOwnerVerdict(stored, state)).toBe('live')
    }
  })

  it('keeps a stored release free with whatever evidence it wrote', () => {
    const released = lease({
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null
    })
    const state = deriveAgentSessionLeaseState(released, null)
    expect(state.state).toBe('free')
    // Recovery released it without proof: free to acquire, but nothing says the owner exited.
    expect(agentSessionLeaseOwnerVerdict(released, state)).toBe('unverifiable')
  })
})

describe('owner verdict and evidence', () => {
  it('answers exited for a derived free lease and records what the missed release would have', () => {
    const state = deriveAgentSessionLeaseState(lease(), proof({ ...WATCHED, reason: 'crashed' }))
    expect(agentSessionLeaseOwnerVerdict(lease(), state)).toBe('exited')
    expect(
      state.state === 'free' && agentSessionLeaseFreeEvidence(lease(), state.basis, 1_000)
    ).toEqual({
      kind: 'exit-observed',
      detail: 'crashed',
      observedAt: 900,
      ownerFence: 7
    })
  })

  it('bounds a probed death by the last renewal', () => {
    const state = deriveAgentSessionLeaseState(lease(), proof(PID_ABSENT))
    expect(
      state.state === 'free' && agentSessionLeaseFreeEvidence(lease(), state.basis, 2_000)
    ).toEqual({
      kind: 'pid-absent',
      detail: 'recorded pid absent on host',
      observedAt: 2_000,
      ownerFence: 7,
      lastProvenAliveAt: 500
    })
  })

  it('answers unverifiable, never live, for a stored live claim nothing proves', () => {
    expect(
      agentSessionLeaseOwnerVerdict(lease(), deriveAgentSessionLeaseState(lease(), null))
    ).toBe('unverifiable')
  })
})
