// A refusal's details name the situation, so every place that answers for a refusal — the first
// reply, a ledger replay, the store fallback copy — must name the same one.

import { describe, expect, it } from 'vitest'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session-record.test-fixture'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { classifyStoreFailure } from './structured-agent-session-attach'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal
} from './structured-agent-session-adapter'
import {
  failedAcquisitionRefusal,
  failedAcquisitionSettlement
} from './structured-agent-session-failed-create-refusal'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'

function replay(outcome: Parameters<typeof resolveAgentSessionReplayOutcome>[0]['outcome']) {
  return resolveAgentSessionReplayOutcome({
    operationId: 'op-1',
    outcome,
    reconstruct: () => null
  })
}

describe('a ledger replay names the details its first answer did', () => {
  it.each([
    [new AgentSessionAcquisitionRefusal('not signed in', 'notSignedIn'), 'notSignedIn'],
    [
      new AgentSessionAcquisitionExitProvenError(
        withObservedProviderExit(new Error('exited (code 1)'))
      ),
      'providerStartFailed'
    ],
    // Gone now, with no exit observed: no situation, on the first answer or the replay.
    [new AgentSessionAcquisitionExitProvenError(new Error('spawn codex ENOENT')), undefined]
  ])('for a failed create: %s', (error, reason) => {
    const first = failedAcquisitionRefusal(error)
    const replayed = replay(failedAcquisitionSettlement(error).outcome)
    expect(first?.refusal.details?.reason).toBe(reason)
    expect(replayed).toMatchObject({
      decision: 'refuse',
      refusal: { code: first?.refusal.code, ...(reason ? { details: first?.refusal.details } : {}) }
    })
    if (!reason) {
      expect(replayed).not.toHaveProperty('refusal.details')
    }
  })

  it('for a create whose cleanup could not prove the child gone', () => {
    const outcome = failedAcquisitionSettlement(
      new AgentSessionAcquisitionExitUnprovenError(new Error('probe failed'))
    ).outcome
    expect(replay(outcome)).toMatchObject({
      refusal: { code: 'agent_session_ownership_unknown', details: { reason: 'ownerUnproven' } }
    })
  })

  it('replays the facts beside the reason, and mirrors them where released clients read', () => {
    const resolution = {
      state: 'resolved' as const,
      selectedOptionId: 'allow',
      resolvedBy: 'phone',
      resolvedAt: 5
    }
    const replayed = replay({
      status: 'failed',
      code: 'agent_session_item_revision_stale',
      details: { reason: 'promptMoved', currentRevision: 3, resolution }
    })
    expect(replayed).toMatchObject({
      refusal: {
        code: 'agent_session_item_revision_stale',
        details: { reason: 'promptMoved', currentRevision: 3, resolution },
        currentRevision: 3,
        resolution
      }
    })
  })

  it('reads a row an older host wrote, with no details, as naming none', () => {
    const replayed = replay({ status: 'failed', code: 'agent_session_conflict' })
    expect(replayed).toMatchObject({ refusal: { code: 'agent_session_conflict' } })
    expect(replayed.decision === 'refuse' && replayed.refusal).not.toHaveProperty('details')
  })

  it('drops the cause an unreleased build wrote, and a reason the code does not list', () => {
    for (const row of [
      { status: 'failed' as const, code: 'agent_session_conflict', cause: 'claimConflicted' },
      {
        status: 'failed' as const,
        code: 'agent_session_conflict',
        details: { reason: 'promptGone' as const }
      }
    ]) {
      const replayed = replay(row)
      expect(replayed).toMatchObject({ refusal: { code: 'agent_session_conflict' } })
      expect(replayed.decision === 'refuse' && replayed.refusal).not.toHaveProperty('details')
    }
  })

  it('names a code this build cannot place as refused earlier', () => {
    expect(replay({ status: 'failed', code: 'agent_session_future_code' })).toMatchObject({
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'operationRefusedEarlier' }
      }
    })
  })

  it('names a lost outcome and a lost result', () => {
    expect(replay({ status: 'unknown' })).toMatchObject({
      refusal: { details: { reason: 'outcomeUnknown' } }
    })
    expect(replay({ status: 'succeeded', sessionId: 's' })).toMatchObject({
      refusal: { details: { reason: 'resultLost' } }
    })
  })
})

describe('the store fallback copy', () => {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-1' }
    })
  )

  it('words a situation its code would misdescribe by the situation', () => {
    const refusal = classifyStoreFailure(
      agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'replaySuperseded' }),
      null,
      record
    )
    expect(refusal).toMatchObject({
      code: 'agent_session_ownership_unknown',
      details: { reason: 'replaySuperseded' }
    })
    // Not the latched-owner story: this owner is not in doubt, the replay is just stale.
    expect(refusal.message).not.toContain('4242')
  })

  it('keeps the latched-owner story, with its reason, for an owner it cannot prove gone', () => {
    const refusal = classifyStoreFailure(
      agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' }),
      null,
      record
    )
    expect(refusal.details?.reason).toBe('ownerUnproven')
    expect(refusal.message).toContain('4242')
  })

  it('does not promise an update fixes a record this build cannot read', () => {
    // Unreadable covers a damaged record as well as one a newer build wrote.
    expect(
      classifyStoreFailure(
        agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' }),
        null,
        null
      )
    ).toEqual({
      code: 'execution_owner_reconciling',
      details: { reason: 'recordUnreadable' },
      message:
        "Orca can't read this chat's saved state. If a newer version of Orca saved it, update Orca to open it; otherwise start a new chat."
    })
  })

  it('names the latch for a bare code an older path still throws', () => {
    expect(
      classifyStoreFailure(new Error('agent_session_conflict'), null, {
        ...record,
        lease: { ...record.lease, claimStatus: 'conflicted' }
      }).details
    ).toEqual({ reason: 'claimConflicted' })
    expect(
      classifyStoreFailure(new Error('agent_session_conflict'), null, null)
    ).not.toHaveProperty('details')
  })

  it('puts the current fence in the details of a stale checkpoint, and mirrors it', () => {
    expect(
      classifyStoreFailure(
        agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'fenceStale' }),
        7,
        null
      )
    ).toEqual({
      code: 'agent_session_checkpoint_stale',
      details: { reason: 'fenceStale', currentFence: 7 },
      currentFence: 7,
      message: 'The session store refused this call: agent_session_checkpoint_stale.'
    })
    // A bare code names no reason, but the fence is still a fact.
    expect(
      classifyStoreFailure(new Error('agent_session_checkpoint_stale'), 7, null)
    ).toMatchObject({ details: { currentFence: 7 }, currentFence: 7 })
  })
})
