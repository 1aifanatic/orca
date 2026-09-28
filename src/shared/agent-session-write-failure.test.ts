import { describe, expect, it } from 'vitest'
import {
  agentSessionRefusalFailure,
  agentSessionRpcErrorFailure,
  agentSessionThrownRefusal,
  parseAgentSessionWriteFailure
} from './agent-session-write-failure'

const HOST_TEXT = 'Expected runtime fence 1; the session is at 3.'

function saved(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('parseAgentSessionWriteFailure', () => {
  // The shape saved before refusals carried a reason; it loads as it was and reads as its code.
  it('reads back an entry saved with the code alone, unchanged', () => {
    expect(
      parseAgentSessionWriteFailure(saved({ kind: 'refused', code: 'agent_session_conflict' }))
    ).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
    expect(parseAgentSessionWriteFailure({ kind: 'failed' })).toEqual({ kind: 'failed' })
    expect(
      parseAgentSessionWriteFailure({
        kind: 'refused',
        code: 'agent_session_conflict',
        message: HOST_TEXT
      })
    ).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
  })

  it.each([
    [
      'a reason',
      { kind: 'refused', code: 'agent_session_conflict', details: { reason: 'chatStarting' } }
    ],
    [
      "a rewind's reason",
      {
        kind: 'refused',
        code: 'agent_session_operation_invalid',
        details: { reason: 'rewindRefused', rewindReason: 'busy' }
      }
    ],
    [
      "the owner's verdict",
      {
        kind: 'refused',
        code: 'agent_session_ownership_unknown',
        details: { reason: 'ownerUnproven', ownerVerdict: 'exited' }
      }
    ]
  ])('keeps %s', (_label, value) => {
    expect(parseAgentSessionWriteFailure(saved(value))).toEqual(value)
  })

  // A newer build's reason or verdict is dropped, never guessed; the code's words stand.
  it.each([
    [{ reason: 'fromTheFuture' }, undefined],
    [{ reason: 'fromTheFuture', ownerVerdict: 'exited' }, { ownerVerdict: 'exited' }],
    [{ reason: 'ownerUnproven', ownerVerdict: 'gone' }, { reason: 'ownerUnproven' }],
    [{ reason: 'chatStarting' }, undefined]
  ])('drops what this build cannot place: %j', (details, kept) => {
    expect(
      parseAgentSessionWriteFailure({
        kind: 'refused',
        code: 'agent_session_ownership_unknown',
        details
      })
    ).toEqual({
      kind: 'refused',
      code: 'agent_session_ownership_unknown',
      ...(kept ? { details: kept } : {})
    })
  })

  it.each([
    null,
    'The agent was restarting.',
    { kind: 'refused' },
    { kind: 'refused', code: 'agent_session_from_the_future' },
    { kind: 'something-else' }
  ])('drops %j instead of guessing', (value) => {
    expect(parseAgentSessionWriteFailure(value)).toBeUndefined()
  })
})

describe('agentSessionRefusalFailure', () => {
  // What moves with the owner, the question's answer and the host's words are never kept.
  it('keeps only the facts that stay true after a reload', () => {
    expect(
      agentSessionRefusalFailure({
        code: 'agent_session_checkpoint_stale',
        details: { reason: 'fenceStale', currentFence: 3, ownerVerdict: 'exited' }
      })
    ).toEqual({
      kind: 'refused',
      code: 'agent_session_checkpoint_stale',
      details: { reason: 'fenceStale' }
    })
    // A prompt's revision and winning answer, and a provider's diagnostic, as a host may send them.
    const answered = JSON.parse(
      JSON.stringify({
        code: 'agent_session_already_resolved',
        details: {
          reason: 'promptAlreadyResolved',
          currentRevision: 2,
          resolution: { state: 'answered', selectedOptionId: 'yes', resolvedBy: 'phone' },
          detail: { text: 'stderr', audience: 'log' }
        }
      })
    )
    expect(agentSessionRefusalFailure(answered)).toEqual({
      kind: 'refused',
      code: 'agent_session_already_resolved',
      details: { reason: 'promptAlreadyResolved' }
    })
  })

  it('keeps a code from a newer host without reading its details', () => {
    const refusal = JSON.parse('{"code":"agent_session_from_the_future","details":{"reason":"x"}}')
    expect(agentSessionRefusalFailure(refusal)).toEqual({
      kind: 'refused',
      code: 'agent_session_from_the_future'
    })
  })
})

describe('a refusal the host threw', () => {
  // The RPC error's data `mapRuntimeError` sends for it (wire code `runtime_error`), as it
  // reaches a client over JSON.
  const data = saved({
    refusal: {
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalOwnedElsewhere', processKind: 'dev-desktop' }
    }
  })

  it('is read from the error data, reason and process kind kept', () => {
    const refusal = {
      kind: 'refused',
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalOwnedElsewhere', processKind: 'dev-desktop' }
    }
    expect(agentSessionThrownRefusal(data)).toEqual(refusal)
    // Not "Orca couldn't confirm what happened": the host refused it before running it.
    expect(agentSessionRpcErrorFailure('runtime_error', data)).toEqual(refusal)
  })

  it("degrades a reason or kind another build added to the code's own words", () => {
    const newer = {
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalFromTheFuture', processKind: 'phone' }
      }
    }
    expect(agentSessionThrownRefusal(newer)).toEqual({
      kind: 'refused',
      code: 'agent_session_journal_unreadable'
    })
  })

  it('finds none in an error that carries no refusal', () => {
    expect(agentSessionThrownRefusal(undefined)).toBeUndefined()
    expect(
      agentSessionThrownRefusal({ refusal: { code: 'agent_session_from_the_future' } })
    ).toBeUndefined()
    expect(agentSessionRpcErrorFailure('runtime_error', { nextSteps: [] })).toEqual({
      kind: 'unconfirmed'
    })
  })
})
