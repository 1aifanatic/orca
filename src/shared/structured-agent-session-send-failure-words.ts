// The words for a chat send that did not go through: a rejection the host recorded, a refusal, or
// a message this client could not store.

import {
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from './agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from './agent-session-write-notice-copy'
import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionAttemptFailure } from './structured-agent-session-outbox'

/** A message this client couldn't store to send; the composer's draft still has it. */
export const STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED: readonly AgentSessionWriteNoticePart[] = [
  'messageNotSaved',
  'tryAgain'
]

/**
 * What to put on screen for a rejection.
 *
 * A content rejection's reason is the provider explaining itself, so it is shown
 * verbatim — "Claude does not support the image type .bmp" is the whole answer and
 * a generic string would throw it away. A transport rejection's reason is an
 * internal marker; printing it put `provider_write_failed: broken pipe` in front of
 * users, which names nothing they can act on. That case gets copy that says what
 * happened, and on the phone that the message can be sent again — which it can,
 * because the frame provably never left, so a resend cannot duplicate.
 *
 * The null default claims no cause and no next step, because at that point we know
 * neither: all it asserts is the one thing every rejection shares.
 *
 * Exported because a client without an outbox needs the same copy: the rule about
 * which reasons a person may read is a property of the reason, not of the queue.
 */
export function structuredAgentSessionRejectionNotice(
  reason: string | null,
  write: 'send' | 'composer-send'
): string {
  return agentSessionWriteNoticeEnglish(structuredAgentSessionRejectionParts(reason, write))
}

export function structuredAgentSessionRejectionParts(
  reason: string | null,
  write: 'send' | 'composer-send',
  /** The host's typed fact, which decides when the row carried one. */
  fact?: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext = {}
): AgentSessionWriteNoticePart[] {
  if (fact) {
    return rejectionFactParts(write, fact, context)
  }
  if (reason === null) {
    return ['notDoneSend']
  }
  const rejection = classifyDispatchRejection({ reason })
  if (rejection.kind === 'writeFailed') {
    return ['unreachable', ...agentSessionWriteNotDoneParts(write)]
  }
  // A legacy marker is an internal cause with no user-facing meaning; any other reason is a
  // sentence written to be read — the provider's, or the host's own.
  return rejection.kind ? agentSessionWriteNotDoneParts(write) : [{ text: reason }]
}

function rejectionFactParts(
  write: 'send' | 'composer-send',
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext
): AgentSessionWriteNoticePart[] {
  const { kind } = classifyDispatchRejection({ reason: null, rejection: fact })
  if (kind === 'writeFailed') {
    return ['unreachable', ...agentSessionWriteNotDoneParts(write)]
  }
  // A fact this build cannot place proves only that the message did not happen.
  return kind
    ? [{ failure: { ...fact, kind }, surface: 'rejection', context }]
    : agentSessionWriteNotDoneParts(write)
}

/** Kinds whose words need what the message's copy drops: the provider's detail, or the refusal. */
const WORDED_FROM_WHOLE_FACT: ReadonlySet<AgentSessionFailureFact['kind']> = new Set<
  AgentSessionFailureFact['kind']
>(['providerRejected', 'startFailed', 'restartFailed'])

/** Why a message the host recorded, or a queued card, did not go through. */
export function structuredAgentSessionAttemptFailureParts(
  failure: StructuredAgentSessionAttemptFailure,
  context: AgentSessionFailureWordsContext = {},
  /** The journal's whole fact for a recorded rejection, when its submission is loaded: the
   *  message's own copy keeps only its kind and attachment. */
  recorded?: AgentSessionFailureFact
): AgentSessionWriteNoticePart[] {
  if (failure.kind !== 'rejected') {
    return agentSessionWriteNoticeParts(failure, 'send', context)
  }
  const fact = recorded ?? failure.rejection
  // Without the journal's fact, the host's sentence still holds what the copy dropped.
  if (!recorded && fact && WORDED_FROM_WHOLE_FACT.has(fact.kind) && failure.reason !== null) {
    return [{ text: failure.reason }]
  }
  return structuredAgentSessionRejectionParts(failure.reason, 'send', fact, context)
}
