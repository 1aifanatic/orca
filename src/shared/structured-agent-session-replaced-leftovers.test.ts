import { describe, expect, it } from 'vitest'
import type { AgentSessionWireRefusal } from './agent-session-wire'
import {
  classifyReplacedLeftover,
  refusalProvesUnrecorded,
  resolveReplacedLeftover
} from './structured-agent-session-replaced-leftovers'
import {
  createStructuredAgentSessionOutboxEntry,
  stageStructuredAgentSessionOutboxEntryForSend
} from './structured-agent-session-outbox'
import {
  disposeStructuredAgentSessionSendFailure,
  disposeStructuredAgentSessionSendResult
} from './structured-agent-session-send-disposition'

const fresh = createStructuredAgentSessionOutboxEntry({
  clientMessageId: 'm1',
  sessionId: 'old',
  text: 'hi',
  attachments: [],
  queuedAt: 1
})

function refused(refusal: AgentSessionWireRefusal, resend = false) {
  const sent = stageStructuredAgentSessionOutboxEntryForSend(fresh, 5)
  const asked = resend ? { ...sent, state: 'queued' as const } : fresh
  return disposeStructuredAgentSessionSendResult({
    entries: [resend ? stageStructuredAgentSessionOutboxEntryForSend(asked, 9) : sent],
    entry: asked,
    result: { ok: false, refusal },
    createOperationId: () => 'm1-again'
  }).entries[0]!
}

const NON_PROVING: AgentSessionWireRefusal[] = [
  { code: 'agent_session_operation_unknown', message: 'x' },
  { code: 'agent_session_operation_expired', message: 'x' },
  { code: 'agent_session_operation_invalid', details: { reason: 'messageIdReused' }, message: 'x' },
  { code: 'agent_session_operation_conflict', message: 'x' },
  {
    code: 'agent_session_ownership_unknown',
    details: { reason: 'sessionNotAttached' },
    message: 'x'
  }
]

describe("the one proof rule for a cleared chat's leftovers", () => {
  it('a refusal proves nothing was recorded only when the host could tell', () => {
    for (const refusal of NON_PROVING) {
      expect(refusalProvesUnrecorded(refusal), refusal.code).toBeNull()
      expect(resolveReplacedLeftover({ ok: false, refusal }, true), refusal.code).toBe('askAgain')
    }
    expect(resolveReplacedLeftover('thrown', true)).toBe('askAgain')
    expect(
      refusalProvesUnrecorded({
        code: 'agent_session_operation_invalid',
        details: { reason: 'conversationCleared' }
      })
    ).toBe('cleared')
    expect(refusalProvesUnrecorded({ code: 'agent_session_owner_restart_failed' })).toBe('notSent')
  })

  it('a host that does not advertise its answers as proof is asked again whatever it refuses', () => {
    const cleared: AgentSessionWireRefusal = {
      code: 'agent_session_operation_invalid',
      details: { reason: 'conversationCleared' },
      message: 'x'
    }
    expect(resolveReplacedLeftover({ ok: false, refusal: cleared }, true)).toEqual({
      handBack: 'cleared'
    })
    // An older host may refuse an id it already ran as cleared.
    expect(resolveReplacedLeftover({ ok: false, refusal: cleared }, false)).toBe('askAgain')
    expect(
      resolveReplacedLeftover(
        {
          ok: true,
          replayed: true,
          fence: 1,
          cursor: { epoch: 'e', sequence: 1 },
          value: {
            clientMessageId: 'm1',
            submission: {
              clientMessageId: 'm1',
              fence: 1,
              payloadFingerprint: 'fingerprint',
              dispatchState: 'accepted',
              providerItemId: null,
              reason: null,
              submittedAt: 1,
              resolvedAt: 2
            }
          }
        },
        false
      )
    ).toBe('recorded')
  })

  it('a refused first attempt says its own cause, not the clear', () => {
    const owner = refused({ code: 'agent_session_owner_restart_failed', message: 'x' })
    expect(owner).toMatchObject({ lastAttemptAt: null, state: 'rejected' })
    expect(classifyReplacedLeftover(owner, new Set())).toEqual({
      kind: 'handBack',
      cause: 'notSent'
    })
    const cleared = refused({
      code: 'agent_session_operation_invalid',
      details: { reason: 'conversationCleared' },
      message: 'x'
    })
    expect(classifyReplacedLeftover(cleared, new Set())).toEqual({
      kind: 'handBack',
      cause: 'cleared'
    })
  })

  it('a refusal saved on a kept id is in doubt: an earlier attempt may have landed', () => {
    for (const refusal of [
      ...NON_PROVING,
      {
        code: 'agent_session_operation_invalid' as const,
        details: { reason: 'conversationCleared' as const },
        message: 'x'
      }
    ]) {
      const kept = refused(refusal, true)
      expect(kept.clientMessageId).toBe('m1')
      expect(classifyReplacedLeftover(kept, new Set()), refusal.code).toEqual({ kind: 'inDoubt' })
    }
  })

  it('a failed save is never-sent, a failure after sending is in doubt; a never-attempted message never left', () => {
    expect(
      classifyReplacedLeftover({ ...fresh, lastFailure: { kind: 'failed' } }, new Set())
    ).toEqual({ kind: 'handBack', cause: 'notSent' })
    // A failure after the request went out (an answer that timed out) may have landed.
    const failedAfterSend = disposeStructuredAgentSessionSendFailure({
      entries: [stageStructuredAgentSessionOutboxEntryForSend(fresh, 5)],
      entry: fresh,
      cause: new Error('Timed out waiting for the remote Orca runtime to respond.'),
      isDeliveryUnknown: () => false
    }).entries[0]!
    expect(failedAfterSend).toMatchObject({ lastAttemptAt: 5, lastFailure: { kind: 'failed' } })
    expect(classifyReplacedLeftover(failedAfterSend, new Set())).toEqual({ kind: 'inDoubt' })
    expect(classifyReplacedLeftover(fresh, new Set())).toEqual({
      kind: 'handBack',
      cause: 'cleared'
    })
    expect(classifyReplacedLeftover(fresh, new Set(['m1']))).toEqual({ kind: 'owned' })
  })
})
