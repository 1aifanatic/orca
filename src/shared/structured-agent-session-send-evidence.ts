// What one `agentSession.send` attempt proves about its message, read the way
// `AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY` documents the host's answers.

import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import {
  agentSessionRefusalFailure,
  agentSessionRpcErrorFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteFailure
} from './agent-session-write-failure'

/** The reason a host gives a made-up `unknown` row: its ledger has the id and its journal does not,
 *  so the message may never have been written. */
export const STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING = 'durable_send_submission_missing'

export type StructuredAgentSessionSendAnswer =
  | { kind: 'result'; result: AgentSessionMutationResult<AgentSessionSendResult> }
  | { kind: 'thrown'; error: unknown; rpcCode: string | undefined }

export type StructuredAgentSessionSendEvidence =
  /** The host holds the message (a row in any state, or a queued card): it is the host's now. */
  | { kind: 'recorded' }
  /** Nothing is known yet: the same id goes again, which the host can never run twice. */
  | { kind: 'resend' }
  /** The host holds nothing under this id and runs nothing for it: the text goes back. */
  | { kind: 'not-recorded'; failure: AgentSessionWriteFailure }
  /** An answer that proves nothing about an earlier attempt: it may already be in the chat. */
  | { kind: 'uncertain' }

// RPC codes a host answers before it runs the method: nothing under the id was written.
const TURNED_AWAY_RPC_CODES: ReadonlySet<string> = new Set([
  'method_not_found',
  'method_not_supported',
  'invalid_argument',
  'unauthorized'
])

export function structuredAgentSessionSendEvidence(
  answer: StructuredAgentSessionSendAnswer,
  host: {
    /** The host advertises `agent-session.send-answers-proof.v1`. */
    answersWithProof: boolean
    /** No earlier attempt under this id may have reached the host. */
    firstAttempt: boolean
  }
): StructuredAgentSessionSendEvidence {
  if (answer.kind === 'thrown') {
    // A thrown error, a thrown refusal included, is never proof: the host may have written first.
    // A call turned away proves only that this one wrote nothing; an earlier one may have landed.
    return host.firstAttempt &&
      answer.rpcCode !== undefined &&
      TURNED_AWAY_RPC_CODES.has(answer.rpcCode) &&
      readAgentSessionErrorRefusal(answer.error) === undefined
      ? { kind: 'not-recorded', failure: agentSessionRpcErrorFailure(answer.rpcCode) }
      : { kind: 'resend' }
  }
  const { result } = answer
  if (result.ok) {
    const value: AgentSessionSendResult = result.value
    return 'submission' in value &&
      value.submission.reason === STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
      ? { kind: 'uncertain' }
      : { kind: 'recorded' }
  }
  const failure = agentSessionRefusalFailure(result.refusal)
  if (failure.kind !== 'refused') {
    return { kind: 'resend' }
  }
  const reason = failure.details?.reason
  if (failure.code === 'agent_session_operation_unknown') {
    return reason === 'rewindUnconfirmed' ? { kind: 'not-recorded', failure } : { kind: 'resend' }
  }
  // Nothing under a fresh id can be recorded or running: this call is the only one that carried it.
  if (host.firstAttempt) {
    return { kind: 'not-recorded', failure }
  }
  // A resent id: proof only from a host that answers resends from its record, and not for an
  // expired id, an id holding other content, or a chat this host no longer holds.
  const provesNothing =
    failure.code === 'agent_session_operation_expired' ||
    failure.code === 'agent_session_operation_conflict' ||
    reason === 'messageIdReused' ||
    reason === 'sessionNotAttached'
  return host.answersWithProof && !provesNothing
    ? { kind: 'not-recorded', failure }
    : { kind: 'uncertain' }
}
