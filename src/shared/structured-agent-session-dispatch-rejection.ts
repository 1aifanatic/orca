// Why a submission is `rejected`: the message provably did not happen.
//
// The host writes each rejection twice: `reason`, a sentence (or, for the cases older clients
// already recognise, one of the legacy markers below) that released clients print as it is, and
// `rejection`, the typed fact newer clients read — both from `agentSessionFailureWords`.
// `classifyDispatchRejection` is the only place a reader judges either.
//
// Every rejection makes the one claim that state exists to make: this message did not reach the
// provider. None is ever re-delivered under its own id — `rejected` is terminal in the reducer — so
// a retry rotates the client message id, which is a new message and cannot duplicate.

import { readAgentSessionFailureFact, type AgentSessionFailureKind } from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'

/** Orca could not hand the message over. Written bare: released clients hide it, and the error
 *  that once followed it belongs in the log. Rows from older hosts carry `: <error>` after it. */
export const DISPATCH_REJECTED_WRITE_FAILED = 'provider_write_failed'

/** Local admission refused the frame before any transport was involved. Two
 *  strings rather than one provider-neutral marker because both are already
 *  durable journal reasons; rewording either would relabel rows on disk. */
export const DISPATCH_REJECTED_QUEUE_FULL = 'claude structured dispatch queue is full'
export const DISPATCH_REJECTED_CODEX_QUEUE_FULL = 'codex structured dispatch queue is full'

/** The provider confirmed a queued frame was withdrawn before execution. */
export const DISPATCH_REJECTED_CANCELLED = 'provider_cancelled_before_start'

/** Legacy marker: accepted by a host process that ended before handing it to any provider.
 *  Read only; released clients print it raw, so new rows carry a sentence. */
export const DISPATCH_REJECTED_HOST_RESTARTED = 'host_restarted_before_delivery'

/** Legacy marker: accepted, then the provider was closed before the message was handed to it.
 *  Read only, like the one above. */
export const DISPATCH_REJECTED_PROVIDER_CLOSED = 'provider_closed_before_delivery'

/** True for the internal transport marker, false for a provider's own words. Legacy-reason half
 *  of `isWriteFailureSubmission`; readers go through that or the classifier. */
function dispatchRejectionWasTransportWriteFailure(reason: string | null | undefined): boolean {
  return (
    reason === DISPATCH_REJECTED_WRITE_FAILED ||
    reason?.startsWith(`${DISPATCH_REJECTED_WRITE_FAILED}: `) === true
  )
}

/** Written by restart reconciliation before rows carried a fact; released clients printed it. */
const LEGACY_NOT_DELIVERED = 'not_delivered'

/**
 * What a rejection means for the chat, whatever wrote it:
 * - `withdrawn`: the user's Stop took it back; nothing failed.
 * - `undelivered`: accepted, then never handed over (Orca restarted, the chat closed, the provider
 *   never took it or stopped first).
 * - `startFailed`: the agent it waited on did not start.
 * - `content`: the provider, or Orca's check of the message, refused this payload.
 * - `transport`: Orca could not hand it over.
 */
export type DispatchRejectionCategory =
  | 'withdrawn'
  | 'undelivered'
  | 'startFailed'
  | 'content'
  | 'transport'

export type DispatchRejectionClassification = {
  category: DispatchRejectionCategory
  /** `failure` when the chat reads Failed; null only when no one failed the user: a withdrawal, or
   *  a host restart or chat close that left the message undelivered. */
  verdict: 'failure' | null
  /** The situation, when the row carried one or a legacy marker names it; absent for a legacy
   *  sentence, whose words are all a reader has. */
  kind?: AgentSessionFailureKind
}

/** Status-row kinds never reach a submission; they are classified only so the table is total. */
const KIND_CATEGORY = {
  cancelled: 'withdrawn',
  hostRestarted: 'undelivered',
  chatClosed: 'undelivered',
  notDelivered: 'undelivered',
  providerExited: 'undelivered',
  providerStartFailed: 'startFailed',
  notSignedIn: 'startFailed',
  historyTooLarge: 'startFailed',
  restartFailed: 'startFailed',
  providerRejected: 'content',
  attachmentInvalid: 'content',
  attachmentUnreadable: 'content',
  emptyMessage: 'content',
  queueFull: 'transport',
  writeFailed: 'transport',
  hostFault: 'transport',
  compactionFailed: 'transport',
  compactionUnconfirmed: 'transport',
  cancelUnconfirmed: 'transport',
  answerUnconfirmed: 'transport'
} satisfies Record<AgentSessionFailureKind, DispatchRejectionCategory>

const NO_FAILURE_KINDS: ReadonlySet<AgentSessionFailureKind> = new Set([
  'cancelled',
  'hostRestarted',
  'chatClosed'
])

/** The legacy markers, by the kind each stands for. */
const LEGACY_MARKER_KINDS: ReadonlyMap<string, AgentSessionFailureKind> = new Map([
  [DISPATCH_REJECTED_CANCELLED, 'cancelled'],
  [DISPATCH_REJECTED_HOST_RESTARTED, 'hostRestarted'],
  [DISPATCH_REJECTED_PROVIDER_CLOSED, 'chatClosed'],
  [DISPATCH_REJECTED_QUEUE_FULL, 'queueFull'],
  [DISPATCH_REJECTED_CODEX_QUEUE_FULL, 'queueFull'],
  [LEGACY_NOT_DELIVERED, 'notDelivered']
])

/** The kind a legacy marker stands for; undefined for any other reason, which is a sentence. */
function legacyMarkerKind(reason: string | null): AgentSessionFailureKind | undefined {
  if (dispatchRejectionWasTransportWriteFailure(reason)) {
    return 'writeFailed'
  }
  return reason === null ? undefined : LEGACY_MARKER_KINDS.get(reason)
}

/**
 * The one reader of why a submission was rejected. The typed fact decides when the row carries
 * one this build can place; a row from an older host is read by its legacy marker, and any other
 * reason is a sentence — a provider's, or Orca's before rows were typed — which reads as a
 * content failure.
 */
export function classifyDispatchRejection(
  submission: Pick<AgentJournalSubmission, 'reason' | 'rejection'>
): DispatchRejectionClassification {
  const kind =
    readAgentSessionFailureFact(submission.rejection)?.kind ?? legacyMarkerKind(submission.reason)
  if (!kind) {
    return { category: 'content', verdict: 'failure' }
  }
  return {
    category: KIND_CATEGORY[kind],
    verdict: NO_FAILURE_KINDS.has(kind) ? null : 'failure',
    kind
  }
}

/** A submission that says Orca never handed it over, in any dispatch state: journals written
 *  before this state moved hold it as `unknown` carrying the marker. */
export function isWriteFailureSubmission(
  submission: Pick<AgentJournalSubmission, 'reason' | 'rejection'>
): boolean {
  return (
    readAgentSessionFailureFact(submission.rejection)?.kind === 'writeFailed' ||
    dispatchRejectionWasTransportWriteFailure(submission.reason)
  )
}
