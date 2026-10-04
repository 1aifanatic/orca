import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'

/** What a new start asks its chat to receive. Callers carry no request id, so this is what tells a
 *  repeat of one request (a double click, a retried call) from a different request. */
export type StructuredLaunchRequest = { text: string; draft: boolean }

/** A new start's own create keeps its request and the text it staged; a Retry or re-check of an
 *  existing chat is no request of its own. */
export type StructuredLaunchAttempt =
  | {
      kind: 'first'
      request: StructuredLaunchRequest
      stagedEntry: StructuredAgentSessionOutboxEntry | null
    }
  | { kind: 'retry' }

/** A pick that carries no text, as the + menu and new-tab search make. */
export const BLANK_STRUCTURED_LAUNCH_REQUEST: StructuredLaunchRequest = { text: '', draft: false }

export function structuredLaunchRequest(options: {
  prompt?: string
  promptDelivery?: string
}): StructuredLaunchRequest {
  const text = options.prompt?.trim() ?? ''
  // Without text the delivery mode carries nothing: two blank starts are one request.
  return { text, draft: text !== '' && options.promptDelivery === 'draft' }
}

/** The first attempt `request` repeats, whose text is already staged or seeded. */
export function repeatedStructuredLaunchAttempt(
  attempt: StructuredLaunchAttempt,
  request: StructuredLaunchRequest
): Extract<StructuredLaunchAttempt, { kind: 'first' }> | undefined {
  return attempt.kind === 'first' &&
    attempt.request.text === request.text &&
    attempt.request.draft === request.draft
    ? attempt
    : undefined
}

/** Only a new start's own create is joined, and only by a repeat of its request. Without `request`,
 *  any new start's own create counts. */
export function joinsFirstLaunchAttempt(
  attempt: StructuredLaunchAttempt,
  request?: StructuredLaunchRequest
): boolean {
  return (
    attempt.kind === 'first' &&
    (!request || repeatedStructuredLaunchAttempt(attempt, request) !== undefined)
  )
}
