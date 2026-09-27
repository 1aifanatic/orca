// The facts a start or an exit reduces to, and the one place a failed start is worded. The
// sentence itself comes from `agentSessionFailureWords`, beside the fact it states.

import {
  agentSessionFailureFact,
  providerDiagnosticOf,
  type AgentSessionFailureFact,
  type ProviderDiagnostic
} from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import {
  agentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'

/** Marks the error an adapter observed its child's exit with, where it observed it. */
export function withObservedProviderExit<TError extends Error>(error: TError): TError {
  return Object.assign(error, { providerExitObserved: true })
}

function providerExitObserved(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if ('providerExitObserved' in current && current.providerExitObserved === true) {
      return true
    }
    current = current.cause
  }
  return false
}

/** A start that did not land. A refusal the adapter typed keeps its situation, and an exit the
 *  adapter observed says the provider stopped; anything else blames no one — it may be Orca's, or
 *  a spawn that failed. Either keeps the provider's diagnostic when the error carried one. */
export function providerStartupFailureFact(cause?: unknown): AgentSessionFailureFact {
  if (
    cause instanceof AgentSessionAcquisitionRefusal &&
    (cause.refusalCause === 'notSignedIn' || cause.refusalCause === 'historyTooLarge')
  ) {
    return agentSessionFailureFact(cause.refusalCause)
  }
  return agentSessionFailureFact(
    providerExitObserved(cause) ? 'providerStartFailed' : 'startFailed',
    { detail: providerDiagnosticOf(cause) }
  )
}

/** A child that ended before it proved its start: an exit is a start that failed, keeping the
 *  provider's diagnostic; an Orca fault or a typed start refusal stays what it was. */
function startupFailureFromExit(
  failure: AgentSessionFailureFact | undefined
): AgentSessionFailureFact {
  if (!failure || failure.kind === 'providerExited') {
    return agentSessionFailureFact('providerStartFailed', { detail: failure?.detail })
  }
  return failure
}

/** What the chat records when the delivery loop could not make the session ready. */
function restartFailureFact(refusal: AgentSessionWireRefusal): AgentSessionFailureFact {
  if (refusal.cause === 'notSignedIn' || refusal.cause === 'historyTooLarge') {
    return agentSessionFailureFact(refusal.cause)
  }
  // A child that died starting reads as any start that died does.
  if (refusal.ownerVerdict === 'exited' || refusal.cause === 'providerStartFailed') {
    return agentSessionFailureFact('providerStartFailed')
  }
  return agentSessionFailureFact('restartFailed', {
    refusal: agentSessionRefusalReference(refusal)
  })
}

/** Why a start the chat needed did not land, as the place that saw it knows it. */
export type StructuredAgentSessionStartFailureCause =
  /** The session could not be made ready. */
  | { refusal: AgentSessionWireRefusal }
  /** A start that threw, or an adapter's own startup failure; any diagnostic it carries. */
  | { error: unknown }
  /** The child ended before it proved its start, as its ended event told it. */
  | { exit: AgentSessionFailureFact | undefined }
  /** The provider exited while starting; only its words are known, and the caller names their
   *  audience. */
  | { diagnostic: ProviderDiagnostic | undefined }
  /** Orca's own fault; its error belongs in the log. */
  | { hostFault: true }
  /** Already typed where it was observed. */
  | { failure: AgentSessionFailureFact }

/** A start failure's row repeats the sentence its rejected messages carry: both are about the
 *  messages the start was for. */
export type StructuredAgentSessionStartFailureWords = AgentJournalDispatchRejection

function startFailureFact(cause: StructuredAgentSessionStartFailureCause): AgentSessionFailureFact {
  if ('refusal' in cause) {
    return restartFailureFact(cause.refusal)
  }
  if ('error' in cause) {
    return providerStartupFailureFact(cause.error)
  }
  if ('exit' in cause) {
    return startupFailureFromExit(cause.exit)
  }
  if ('diagnostic' in cause) {
    return agentSessionFailureFact('providerStartFailed', { detail: cause.diagnostic })
  }
  if ('hostFault' in cause) {
    return agentSessionFailureFact('hostFault')
  }
  return cause.failure
}

/** The one place a failed start is worded: the error row and every message it rejects carry this
 *  sentence and this fact, whichever writer saw the start fail. */
export function structuredAgentSessionStartFailure(
  cause: StructuredAgentSessionStartFailureCause,
  context: AgentSessionFailureWordsContext = {}
): StructuredAgentSessionStartFailureWords {
  return agentSessionFailureWords(startFailureFact(cause), { ...context, surface: 'rejection' })
}
