import { describe, expect, it } from 'vitest'
import {
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../../shared/agent-session-failure'
import { AgentSessionRefusalError, refuse } from '../../../shared/agent-session-wire-refusals'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { MAX_UNEXPECTED_EXIT_REASON_CHARS } from './structured-agent-session-dead-generation-settlement'
import {
  structuredAgentSessionStartFailure,
  withObservedProviderExit
} from './structured-agent-session-failure-text'

/** What Orca's own error text looks like: a code, a marker, a uuid, a path, an exception. */
const ORCA_INTERNAL =
  /agent_session_|execution_owner|provider_[a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}-|[/\\][\w.-]+[/\\]|Error:|ENOENT/

describe('structuredAgentSessionStartFailure', () => {
  it('keeps a provider diagnostic only when the error carried one', () => {
    const carried = withProviderDiagnostic(
      new Error('claude stream-json exited (code 1): boom'),
      providerDiagnostic('code 1\nboom', 'log')
    )
    expect(structuredAgentSessionStartFailure({ error: carried }, { agentName: 'Claude' })).toEqual(
      {
        reason: "Claude couldn't start.",
        rejection: { kind: 'startFailed', detail: { text: 'code 1\nboom', audience: 'log' } }
      }
    )
    // Orca's own words, however provider-like, are never promoted to a detail.
    expect(
      structuredAgentSessionStartFailure({ error: new Error('Not logged in. Run /login.') })
        .rejection
    ).toEqual({ kind: 'startFailed' })
  })

  it('keeps a start refusal the adapter typed', () => {
    const refusal = new AgentSessionAcquisitionRefusal(
      'Claude is not signed in for the selected account.',
      'agent_session_operation_invalid',
      'notSignedIn'
    )
    expect(structuredAgentSessionStartFailure({ error: refusal }, { agentName: 'Claude' })).toEqual(
      {
        reason:
          'Claude is not signed in for the selected account. Sign in, then send your message again.',
        rejection: { kind: 'notSignedIn' }
      }
    )
  })

  it('words a refused restart by its situation, never its message', () => {
    const words = structuredAgentSessionStartFailure(
      {
        refusal: refuse(
          'agent_session_ownership_unknown',
          'ownerUnproven',
          'Orca cannot prove that process 4242 on host-1 has exited.'
        )
      },
      { agentName: 'Claude' }
    )
    expect(words).toEqual({
      reason: "Claude couldn't restart.",
      rejection: {
        kind: 'restartFailed',
        refusal: { code: 'agent_session_ownership_unknown', cause: 'ownerUnproven' }
      }
    })
  })

  it("reads an exit before the start as a failed start, and an Orca fault as Orca's", () => {
    expect(
      structuredAgentSessionStartFailure({
        exit: { kind: 'providerExited', detail: { text: 'stderr', audience: 'log' } }
      }).rejection
    ).toEqual({ kind: 'providerStartFailed', detail: { text: 'stderr', audience: 'log' } })
    expect(structuredAgentSessionStartFailure({ exit: { kind: 'hostFault' } }).rejection).toEqual({
      kind: 'hostFault'
    })
    expect(structuredAgentSessionStartFailure({ hostFault: true }).reason).not.toMatch(
      ORCA_INTERNAL
    )
  })

  it("holds any provider detail to the lease record's cap", () => {
    expect(MAX_PROVIDER_DIAGNOSTIC_CHARS).toBe(512)
    expect(MAX_UNEXPECTED_EXIT_REASON_CHARS).toBe(MAX_PROVIDER_DIAGNOSTIC_CHARS)
    const long = 'x'.repeat(4_000)
    // However the caller built the detail, the fact stores at most the cap.
    const words = structuredAgentSessionStartFailure({
      diagnostic: { text: long, audience: 'log' }
    })
    expect(words.rejection.detail?.text).toHaveLength(MAX_UNEXPECTED_EXIT_REASON_CHARS)
    expect(
      structuredAgentSessionStartFailure({
        exit: { kind: 'providerExited', detail: { text: long, audience: 'log' } }
      }).rejection.detail?.text
    ).toHaveLength(MAX_UNEXPECTED_EXIT_REASON_CHARS)
  })

  it('says the provider stopped only when an exit was observed', () => {
    const exited = structuredAgentSessionStartFailure({
      refusal: {
        ...refuse('agent_session_ownership_unknown', 'ownerUnproven', 'probe saw an exit'),
        ownerVerdict: 'exited'
      }
    })
    expect(exited).toEqual({
      reason: 'The provider stopped before it finished starting.',
      rejection: { kind: 'providerStartFailed' }
    })
    // A start that threw proves nothing about the provider: it may be Orca's, or a failed spawn.
    expect(
      structuredAgentSessionStartFailure({ error: new Error('spawn claude ENOENT') }, {})
    ).toEqual({ reason: "The agent couldn't start.", rejection: { kind: 'startFailed' } })
    // The same error, once the adapter that observed the child's exit marked it, blames the provider.
    const exit = withObservedProviderExit(
      withProviderDiagnostic(new Error('exited (code 1)'), providerDiagnostic('code 1', 'log'))
    )
    expect(
      structuredAgentSessionStartFailure({ error: new Error('wrapped', { cause: exit }) })
    ).toEqual({
      reason: 'The provider stopped before it finished starting.',
      rejection: { kind: 'providerStartFailed', detail: { text: 'code 1', audience: 'log' } }
    })
  })

  it('reads a thrown refusal the same as a returned one', () => {
    const thrown = new AgentSessionRefusalError(
      refuse('agent_session_conflict', 'claimConflicted', 'Another process claims this session.')
    )
    expect(thrown.message).toBe('agent_session_conflict')
    expect(structuredAgentSessionStartFailure({ refusal: thrown.refusal }).rejection).toEqual({
      kind: 'restartFailed',
      refusal: { code: 'agent_session_conflict', cause: 'claimConflicted' }
    })
  })
})
