import { describe, expect, it } from 'vitest'
import { agentSessionLeaseFixture } from '../../../shared/agent-session-record.test-fixture'
import type { StructuredAgentSessionEndedChild } from './structured-agent-session-host-types'
import { structuredAgentSessionOwnerProof } from './structured-agent-session-owner-proof'

const LEASE = agentSessionLeaseFixture({
  runtimeFence: 4,
  ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: null, spawnToken: 'spawn-a' }
})

function ended(
  overrides: Partial<StructuredAgentSessionEndedChild> = {}
): StructuredAgentSessionEndedChild {
  return {
    generation: 'generation-1',
    fence: 4,
    rootGone: true,
    cause: 'exit',
    reason: 'provider exited',
    duringStartup: false,
    observedAt: 900,
    endedAt: { epoch: 'epoch-1', sequence: 1 },
    ...overrides
  }
}

function proofFor(
  session: Parameters<typeof structuredAgentSessionOwnerProof>[0]['session'],
  lease = LEASE,
  hostId = 'local'
) {
  return structuredAgentSessionOwnerProof({ lease, hostId, session, attemptInFlight: false })
}

describe('the owner proof a host holds in memory', () => {
  it("names the child it runs at the lease's fence", () => {
    const child = { generation: 'generation-1', fence: 4, phase: 'ready' } as const
    expect(proofFor({ child, lastEndedChild: undefined }).owner).toEqual({ kind: 'runs' })
  })

  it('names an exit it watched, with the provider reason an exit carries', () => {
    expect(proofFor({ child: null, lastEndedChild: ended() }).owner).toEqual({
      kind: 'watched-exit',
      observedAt: 900,
      reason: 'provider exited'
    })
    expect(
      proofFor({ child: null, lastEndedChild: ended({ cause: 'user-stop' }) }).owner
    ).toMatchObject({ kind: 'watched-exit', reason: null })
  })

  it.each([
    [
      'an end that did not prove the root gone',
      { child: null, lastEndedChild: ended({ rootGone: false }) }
    ],
    ['an end at an older fence', { child: null, lastEndedChild: ended({ fence: 3 }) }],
    ['no conversation in memory', undefined]
  ] as const)('proves nothing from %s', (_label, session) => {
    expect(proofFor(session).owner).toEqual({ kind: 'none' })
  })

  it('speaks for no owner on another host, whatever memory holds', () => {
    expect(proofFor({ child: null, lastEndedChild: ended() }, LEASE, 'ssh:devbox').owner).toEqual({
      kind: 'none'
    })
  })
})
