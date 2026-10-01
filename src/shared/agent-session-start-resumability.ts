// How far a failed start got, and so whether Orca tries it again on its own or the person does. One
// classification: the retry schedule and the words both read it.

import type { AgentSessionFailureFact, AgentSessionFailureKind } from './agent-session-failure'
import type { AgentSessionRefusalReason } from './agent-session-refusal-details'
import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'

/**
 * How far a refused start got, by its wire code. `newChat`: this host has nothing to restart the
 * chat from — no record, or none it can run — so only a new chat continues. `hostSide`: the start
 * ran here and failed, which the person retries. `beforeHandoff`: refused before any start, by a
 * settlement that clears on its own. A new wire code does not compile until it is classified here.
 */
export const START_REFUSAL_STAGE: Record<
  AgentSessionWireRefusalCode,
  'newChat' | 'hostSide' | 'beforeHandoff'
> = {
  execution_owner_reconciling: 'beforeHandoff',
  agent_session_conflict: 'beforeHandoff',
  agent_session_checkpoint_stale: 'beforeHandoff',
  // A start whose cleanup could not prove its process gone, or that left no child to write to.
  agent_session_ownership_unknown: 'hostSide',
  agent_session_operation_capacity: 'beforeHandoff',
  structured_agent_session_unsupported: 'newChat',
  agent_session_operation_conflict: 'beforeHandoff',
  agent_session_operation_expired: 'beforeHandoff',
  // A failed acquisition: the spawn, the attach or the provider's own start.
  agent_session_operation_invalid: 'hostSide',
  agent_session_operation_unknown: 'beforeHandoff',
  agent_session_item_revision_stale: 'beforeHandoff',
  agent_session_already_resolved: 'beforeHandoff',
  agent_session_identity_required: 'newChat',
  agent_session_journal_unreadable: 'beforeHandoff',
  agent_session_owner_restart_failed: 'hostSide'
}

/** Start refusals whose situation is itself what the person reads, with its own next step, and
 *  whether that situation can clear without them, so a later automatic start may land. A new one
 *  does not compile until it is classified here. */
export const TYPED_START_REFUSAL_RESUMABLE = {
  notSignedIn: false,
  providerMissing: false,
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

/** Whether Orca tries a failed start again on its own: only a start refused before it ran, by a
 *  situation that clears without the person. One that ran and failed here is the person's to retry
 *  at once. */
export function isResumableStartFailure(
  fact: Pick<AgentSessionFailureFact, 'kind' | 'refusal'>
): boolean {
  if (isTypedStartRefusal(fact.kind)) {
    return TYPED_START_REFUSAL_RESUMABLE[fact.kind]
  }
  const code = fact.refusal?.code
  return code !== undefined && START_REFUSAL_STAGE[code] === 'beforeHandoff'
}
