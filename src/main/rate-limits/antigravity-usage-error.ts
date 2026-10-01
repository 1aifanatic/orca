import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

/**
 * Classifies why the Antigravity CLI could not answer a quota read.
 *
 * Why not a prose match alone: agy prints a structured diagnostic beside the human sentence, and
 * the structure is the stable part. A line like
 *
 * ```
 * AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached…",
 *             "status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true}
 * ```
 *
 * survives rewording of the sentence, which a phrase match does not. The sentences are still read,
 * but only as a fallback for builds or paths that print no structured error.
 */

const AGY_ERROR_PREFIX = 'AGY_ERROR:'

/**
 * Sentences agy has been seen to print for a missing session, lower-cased.
 *
 * Kept deliberately short and generic: these are a fallback for when no structured status is
 * present, so matching the stable fragment beats matching a whole sentence that may gain a suffix.
 */
const SIGNED_OUT_PHRASES = [
  'not logged into antigravity',
  'not logged in',
  'not signed in',
  'please sign in',
  'please log in',
  'sign in to antigravity',
  'no credentials',
  'authentication required'
] as const

export type AntigravityUsageFailure = {
  failureKind: UsageRateLimitFailureKind
  /** True when the account exists but cannot currently be read, so Orca should not blame sign-in. */
  signedOut: boolean
}

type StructuredAgyError = { status?: unknown; error_code?: unknown }

function parseStructuredErrors(output: string): StructuredAgyError[] {
  const parsed: StructuredAgyError[] = []
  for (const line of output.split('\n')) {
    const index = line.indexOf(AGY_ERROR_PREFIX)
    if (index === -1) {
      continue
    }
    const payload = line.slice(index + AGY_ERROR_PREFIX.length).trim()
    if (!payload.startsWith('{')) {
      continue
    }
    try {
      const value: unknown = JSON.parse(payload)
      if (typeof value === 'object' && value !== null) {
        parsed.push(value)
      }
    } catch {
      continue
    }
  }
  return parsed
}

function classifyStructured(error: StructuredAgyError): AntigravityUsageFailure | null {
  const status = typeof error.status === 'string' ? error.status.toUpperCase() : ''
  const code = typeof error.error_code === 'number' ? error.error_code : null
  if (status === 'UNAUTHENTICATED' || code === 401) {
    return { failureKind: 'missing-credentials', signedOut: true }
  }
  if (status === 'PERMISSION_DENIED' || code === 403) {
    // The session is real; the account simply is not entitled to what was asked for.
    return { failureKind: 'no-subscription', signedOut: false }
  }
  if (status === 'RESOURCE_EXHAUSTED' || code === 429) {
    return { failureKind: 'rate-limited', signedOut: false }
  }
  if (code !== null && code >= 500) {
    return { failureKind: 'server', signedOut: false }
  }
  return null
}

/**
 * Reads agy's combined stdout/stderr for a reason the quota could not be read.
 *
 * Returns null when nothing recognisable is present, which the caller reports as an unreadable
 * payload rather than inventing a cause.
 */
export function classifyAntigravityUsageFailure(output: string): AntigravityUsageFailure | null {
  for (const error of parseStructuredErrors(output)) {
    const classified = classifyStructured(error)
    if (classified) {
      return classified
    }
  }
  const lowered = output.toLowerCase()
  if (SIGNED_OUT_PHRASES.some((phrase) => lowered.includes(phrase))) {
    return { failureKind: 'missing-credentials', signedOut: true }
  }
  return null
}
