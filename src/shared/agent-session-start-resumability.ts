// Whether a failed start can clear without the person, so starting again later may land. One
// classification: the retry schedule and the words both read it.

import type { AgentSessionFailureFact, AgentSessionFailureKind } from './agent-session-failure'
import type { AgentSessionRefusalReason } from './agent-session-refusal-details'
import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'

/**
 * Whether a refused start leaves the chat anything to start again from. `false`: this host has
 * nothing to restart it from — no record, or none it can run — so only a new chat continues.
 * A new wire code does not compile until it is classified here.
 */
export const START_REFUSAL_RESUMABLE: Record<AgentSessionWireRefusalCode, boolean> = {
  execution_owner_reconciling: true,
  agent_session_conflict: true,
  agent_session_checkpoint_stale: true,
  agent_session_ownership_unknown: true,
  agent_session_operation_capacity: true,
  structured_agent_session_unsupported: false,
  agent_session_operation_conflict: true,
  agent_session_operation_expired: true,
  agent_session_operation_invalid: true,
  agent_session_operation_unknown: true,
  agent_session_item_revision_stale: true,
  agent_session_already_resolved: true,
  agent_session_identity_required: false,
  agent_session_journal_unreadable: true,
  agent_session_owner_restart_failed: true
}

/** Start refusals whose situation is itself what the person reads, with its own next step, and
 *  whether that situation can clear without them, so a later automatic start may land. A new one
 *  does not compile until it is classified here. */
export const TYPED_START_REFUSAL_RESUMABLE = {
  notSignedIn: false,
  historyTooLarge: false,
  managedAccountEnvOverride: false,
  accountSwitchInProgress: true,
  managedAccountUnsupported: false
} as const satisfies Partial<
  Record<
    AgentSessionFailureKind & AgentSessionRefusalReason<'agent_session_operation_invalid'>,
    boolean
  >
>

export type TypedStartRefusal = keyof typeof TYPED_START_REFUSAL_RESUMABLE

export function isTypedStartRefusal(kind: string | undefined): kind is TypedStartRefusal {
  return kind !== undefined && Object.hasOwn(TYPED_START_REFUSAL_RESUMABLE, kind)
}

/** Whether a failed start can clear without the person: neither its situation nor its refusal
 *  needs them, so trying it again later may land. */
export function isResumableStartFailure(
  fact: Pick<AgentSessionFailureFact, 'kind' | 'refusal'>
): boolean {
  const code = fact.refusal?.code
  return (
    (!isTypedStartRefusal(fact.kind) || TYPED_START_REFUSAL_RESUMABLE[fact.kind]) &&
    (!code || START_REFUSAL_RESUMABLE[code])
  )
}
