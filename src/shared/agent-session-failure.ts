// What went wrong in a chat, typed where the host decides it, beside the sentence a person reads.
//
// The host writes both at once: `text`/`reason` stays a complete sentence because released clients
// print it as it is, and this fact is what newer clients choose their copy and action from. A
// provider's own words ride separately as `detail`, set only where Orca composed them from a
// value the provider wrote — never recovered from a string afterwards, since by then nothing can
// tell a provider's sentence from Orca's.

import {
  readAgentSessionRefusalReference,
  type AgentSessionRefusalReference
} from './agent-session-wire-refusals'

/** One per situation with its own honest next step; a new one needs copy before it compiles. */
export const AGENT_SESSION_FAILURE_KINDS = [
  /** Only an observed exit: the provider stopped while starting. */
  'providerStartFailed',
  /** A start that did not land, with no one to blame: Orca's fault, a failed spawn, a close. */
  'startFailed',
  'notSignedIn',
  'historyTooLarge',
  'managedAccountEnvOverride',
  'accountSwitchInProgress',
  'managedAccountUnsupported',
  'providerExited',
  'restartFailed',
  'providerRejected',
  'attachmentInvalid',
  'attachmentUnreadable',
  'emptyMessage',
  'queueFull',
  'writeFailed',
  'cancelled',
  'chatClosed',
  'hostRestarted',
  'notDelivered',
  'compactionFailed',
  'compactionUnconfirmed',
  'cancelUnconfirmed',
  'answerUnconfirmed',
  'hostFault',
  /** The provider is retrying a request its API refused; not a failure yet. */
  'providerRetrying'
] as const
export type AgentSessionFailureKind = (typeof AGENT_SESSION_FAILURE_KINDS)[number]

export function isAgentSessionFailureKind(value: unknown): value is AgentSessionFailureKind {
  return typeof value === 'string' && AGENT_SESSION_FAILURE_KINDS.some((kind) => kind === value)
}

/** `person`: written by the provider for whoever reads the chat, shown inline. `log`: a stderr
 *  tail or exit status, shown only behind Details. */
export type ProviderDiagnosticAudience = 'person' | 'log'

export type ProviderDiagnostic = {
  text: string
  audience: ProviderDiagnosticAudience
}

/** Stderr can be a whole dump; the row keeps enough to act on. The same cap as the exit reason a
 *  lease record keeps, so a diagnostic never outgrows what the record may store. */
export const MAX_PROVIDER_DIAGNOSTIC_CHARS = 512

/** Which of Orca's checks an image failed. A new one needs a sentence before it compiles. */
export const AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS = [
  'empty',
  'tooLarge',
  'tooMany',
  'totalTooLarge',
  'unsupportedType',
  'notAFile',
  'noSource'
] as const
export type AgentSessionAttachmentProblemReason =
  (typeof AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS)[number]

export type AgentSessionAttachmentProblem = {
  reason: AgentSessionAttachmentProblemReason
  /** The limit it broke: bytes for `tooLarge` and `totalTooLarge`, a count for `tooMany`. */
  limit?: number
}

/** What the provider said it is retrying, in its own fields. */
export type AgentSessionProviderRetry = {
  /** The provider's error type, e.g. `rate_limit` or `overloaded`. */
  error?: string
  /** The HTTP status the request failed with. */
  status?: number
}

export type AgentSessionFailureFact = {
  kind: AgentSessionFailureKind
  /** Provider-authored only; absent whenever Orca wrote the words. */
  detail?: ProviderDiagnostic
  /** On `restartFailed` and `startFailed`: the refusal that kept the agent from starting. */
  refusal?: AgentSessionRefusalReference
  /** On `attachmentInvalid`: which check the attachment failed. */
  attachment?: AgentSessionAttachmentProblem
  /** On `providerRetrying`: why the provider is retrying. */
  retry?: AgentSessionProviderRetry
}

/** Null for empty text, so a writer never records a detail with nothing in it. */
export function providerDiagnostic(
  text: string,
  audience: ProviderDiagnosticAudience
): ProviderDiagnostic | undefined {
  const bounded = text.trim().slice(0, MAX_PROVIDER_DIAGNOSTIC_CHARS).trim()
  return bounded ? { text: bounded, audience } : undefined
}

export function agentSessionFailureFact(
  kind: AgentSessionFailureKind,
  extra: {
    detail?: ProviderDiagnostic
    refusal?: AgentSessionRefusalReference
    attachment?: AgentSessionAttachmentProblem
    retry?: AgentSessionProviderRetry
  } = {}
): AgentSessionFailureFact {
  // Re-bounded here, so no writer can store more than the cap however it built the detail.
  const detail = extra.detail
    ? providerDiagnostic(extra.detail.text, extra.detail.audience)
    : undefined
  return {
    kind,
    ...(detail ? { detail } : {}),
    ...(extra.refusal ? { refusal: extra.refusal } : {}),
    ...(extra.attachment ? { attachment: extra.attachment } : {}),
    ...(extra.retry ? { retry: extra.retry } : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isProviderDiagnostic(value: unknown): value is ProviderDiagnostic {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    (value.audience === 'person' || value.audience === 'log')
  )
}

function readAttachmentProblem(value: unknown): AgentSessionAttachmentProblem | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const reason = AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS.find((known) => known === value.reason)
  if (!reason) {
    return undefined
  }
  const limit = value.limit
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? { reason, limit }
    : { reason }
}

/** A retry as a reader meets it; undefined when it names neither field. */
export function readProviderRetry(value: unknown): AgentSessionProviderRetry | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const error =
    typeof value.error === 'string' && value.error.trim() ? value.error.trim() : undefined
  const status =
    typeof value.status === 'number' && Number.isInteger(value.status) && value.status > 0
      ? value.status
      : undefined
  return error || status
    ? { ...(error ? { error } : {}), ...(status ? { status } : {}) }
    : undefined
}

/** A fact as a reader meets it. Undefined for anything this build cannot place, including a kind a
 *  newer host added, so the reader falls back to what it does for a row with no fact. */
export function readAgentSessionFailureFact(value: unknown): AgentSessionFailureFact | undefined {
  if (!isRecord(value) || !isAgentSessionFailureKind(value.kind)) {
    return undefined
  }
  const refusal = readAgentSessionRefusalReference(value.refusal)
  const attachment = readAttachmentProblem(value.attachment)
  const retry = readProviderRetry(value.retry)
  return agentSessionFailureFact(value.kind, {
    ...(isProviderDiagnostic(value.detail) ? { detail: value.detail } : {}),
    ...(refusal ? { refusal } : {}),
    ...(attachment ? { attachment } : {}),
    ...(retry ? { retry } : {})
  })
}

/** The provider-authored diagnostic an error carries, set only where it was composed. Follows the
 *  `cause` chain, since wrappers such as the acquisition errors keep the original as their cause. */
export function providerDiagnosticOf(error: unknown): ProviderDiagnostic | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if ('providerDiagnostic' in current && isProviderDiagnostic(current.providerDiagnostic)) {
      return current.providerDiagnostic
    }
    if (current instanceof AggregateError) {
      const found = current.errors.map(providerDiagnosticOf).find(Boolean)
      if (found) {
        return found
      }
    }
    current = current.cause
  }
  return undefined
}

/** Attaches the provider's words to the error Orca built around them. */
export function withProviderDiagnostic<TError extends Error>(
  error: TError,
  diagnostic: ProviderDiagnostic | undefined
): TError {
  return diagnostic ? Object.assign(error, { providerDiagnostic: diagnostic }) : error
}
