import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionWireRefusal } from './agent-session-wire'
import {
  structuredAgentSessionSendEvidence,
  type StructuredAgentSessionSendAnswer
} from './structured-agent-session-send-evidence'

function refused(code: string, reason?: string): StructuredAgentSessionSendAnswer {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture names codes from the wire list.
  const refusal = {
    code,
    message: code,
    ...(reason ? { details: { reason } } : {})
  } as AgentSessionWireRefusal
  return { kind: 'result', result: { ok: false, refusal } }
}

const recorded: StructuredAgentSessionSendAnswer = {
  kind: 'result',
  result: {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'e', sequence: 1 },
    value: { clientMessageId: 'm', queued: { messageId: 'm', position: 0, state: 'waiting' } }
  }
}

const proof = { answersWithProof: true, firstAttempt: false }
const older = { answersWithProof: false, firstAttempt: false }
const first = { answersWithProof: false, firstAttempt: true }

describe('structuredAgentSessionSendEvidence', () => {
  it('reads any ok answer as the host holding the message', () => {
    expect(structuredAgentSessionSendEvidence(recorded, first).kind).toBe('recorded')
  })

  it('reads a made-up row for an id the host journal lost as unconfirmed, not recorded', () => {
    const missing: StructuredAgentSessionSendAnswer = {
      kind: 'result',
      result: {
        ok: true,
        replayed: true,
        fence: 1,
        cursor: { epoch: 'e', sequence: 1 },
        value: {
          clientMessageId: 'm',
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the reason is read.
          submission: {
            dispatchState: 'unknown',
            reason: 'durable_send_submission_missing',
            recovered: true
          } as AgentJournalSubmission
        }
      }
    }
    expect(structuredAgentSessionSendEvidence(missing, proof).kind).toBe('uncertain')
  })

  it('resends the same id after a thrown error, a thrown refusal included', () => {
    expect(
      structuredAgentSessionSendEvidence(
        { kind: 'thrown', error: new Error('timeout'), rpcCode: undefined },
        first
      ).kind
    ).toBe('resend')
    const thrownRefusal = {
      response: { error: { data: { refusal: { code: 'agent_session_journal_unreadable' } } } }
    }
    expect(
      structuredAgentSessionSendEvidence(
        { kind: 'thrown', error: thrownRefusal, rpcCode: 'invalid_argument' },
        first
      ).kind
    ).toBe('resend')
  })

  it('treats a call the host turned away before running it as never written', () => {
    expect(
      structuredAgentSessionSendEvidence(
        { kind: 'thrown', error: new Error('x'), rpcCode: 'method_not_found' },
        proof
      ).kind
    ).toBe('not-recorded')
  })

  it('resends on an unknown outcome or a lost result, and hands back an unconfirmed rewind', () => {
    expect(
      structuredAgentSessionSendEvidence(
        refused('agent_session_operation_unknown', 'outcomeUnknown'),
        proof
      ).kind
    ).toBe('resend')
    expect(
      structuredAgentSessionSendEvidence(
        refused('agent_session_operation_unknown', 'resultLost'),
        first
      ).kind
    ).toBe('resend')
    expect(
      structuredAgentSessionSendEvidence(
        refused('agent_session_operation_unknown', 'rewindUnconfirmed'),
        proof
      ).kind
    ).toBe('not-recorded')
  })

  it('reads any other refusal of a first attempt as never written, on any host', () => {
    expect(
      structuredAgentSessionSendEvidence(
        refused('agent_session_ownership_unknown', 'sessionNotAttached'),
        first
      ).kind
    ).toBe('not-recorded')
    expect(structuredAgentSessionSendEvidence(refused('agent_session_conflict'), first).kind).toBe(
      'not-recorded'
    )
  })

  it('reads a resent id refusal as proof only from a host that answers with proof', () => {
    expect(structuredAgentSessionSendEvidence(refused('agent_session_conflict'), proof).kind).toBe(
      'not-recorded'
    )
    expect(structuredAgentSessionSendEvidence(refused('agent_session_conflict'), older).kind).toBe(
      'uncertain'
    )
  })

  it('never reads an expired id, an id holding other content, or a detached chat as proof', () => {
    for (const answer of [
      refused('agent_session_operation_expired', 'operationExpired'),
      refused('agent_session_operation_conflict', 'operationIdReused'),
      refused('agent_session_ownership_unknown', 'sessionNotAttached')
    ]) {
      expect(structuredAgentSessionSendEvidence(answer, proof).kind).toBe('uncertain')
    }
  })
})
