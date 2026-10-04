import {
  launchStateLifecycle,
  structuredLaunchStates,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import type {
  StructuredLaunchAttempt,
  StructuredLaunchRequest
} from './structured-agent-session-launch-request'
import type { AgentLaunchRequestId } from './agent-launch-request-id'
import { isStructuredLaunchChatEmpty } from './structured-agent-session-launch-empty-chat'

// Why: coalescing stops one user action delivered twice (a double click) racing into two chats. Any
// other action, a failed or unconfirmed launch, or a Retry/re-check of one is not that race: a new
// start opens a new chat carrying its own text. A resume keeps holding: the host refuses a second
// adoption.
function holdsLaunchIdentity(
  state: StructuredLaunchState,
  requestId?: AgentLaunchRequestId
): boolean {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'failed' || lifecycle === 'cancelled') {
    return false
  }
  if (state.intent.params.resumeFrom) {
    return true
  }
  const { attempt } = state.callers
  return (
    lifecycle !== 'visibility-unknown' &&
    attempt.kind === 'first' &&
    (requestId === undefined || attempt.requestId === requestId)
  )
}

/** Launches a start of `requestId` would join; without it, every new start's own create. */
export function structuredLaunchesHoldingIdentity(
  matches: (identity: string) => boolean,
  requestId?: AgentLaunchRequestId
): StructuredLaunchState[] {
  return [...structuredLaunchStates()].filter(
    (state) => matches(state.identity) && holdsLaunchIdentity(state, requestId)
  )
}

/** An empty chat (a + pick, the empty-workspace default) still starting: the first request with text
 *  claims it once, and from then on it is that request's chat. A resume is never empty, nor a chat
 *  its user has already sent or typed into. */
export function claimableStructuredLaunchAttempt(
  state: StructuredLaunchState,
  request: StructuredLaunchRequest
): Extract<StructuredLaunchAttempt, { kind: 'first' }> | undefined {
  const { attempt } = state.callers
  return !state.intent.params.resumeFrom &&
    attempt.kind === 'first' &&
    attempt.blank &&
    request.hasText &&
    isStructuredLaunchChatEmpty(state.intent.sessionId)
    ? attempt
    : undefined
}

/** The launch a new start of `request` joins: one it re-delivers, else an empty chat it claims. The
 *  newest wins if a retried resume holds the identity too. */
export function getJoinableStructuredLaunchState(
  identity: string,
  request: StructuredLaunchRequest
): StructuredLaunchState | undefined {
  const matches = (candidate: string): boolean => candidate === identity
  return (
    structuredLaunchesHoldingIdentity(matches, request.id).at(-1) ??
    structuredLaunchesHoldingIdentity(matches).findLast((state) =>
      claimableStructuredLaunchAttempt(state, request)
    )
  )
}
