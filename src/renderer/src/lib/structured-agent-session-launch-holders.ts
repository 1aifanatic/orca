import {
  launchStateLifecycle,
  structuredLaunchStates,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import {
  joinsFirstLaunchAttempt,
  type StructuredLaunchAttempt,
  type StructuredLaunchRequest
} from './structured-agent-session-launch-request'
import { isStructuredLaunchChatEmpty } from './structured-agent-session-launch-empty-chat'

// Why: coalescing stops a repeat of one request (a double click) racing into two chats. A different
// request, a failed or unconfirmed launch, or a Retry/re-check of one is not that race: a new start
// opens a new chat carrying its own text. A resume keeps holding: the host refuses a second adoption.
function holdsLaunchIdentity(
  state: StructuredLaunchState,
  request?: StructuredLaunchRequest
): boolean {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'failed' || lifecycle === 'cancelled') {
    return false
  }
  if (state.intent.params.resumeFrom) {
    return true
  }
  return (
    lifecycle !== 'visibility-unknown' && joinsFirstLaunchAttempt(state.callers.attempt, request)
  )
}

/** Launches a start of `request` would repeat; without `request`, every new start's own create. */
export function structuredLaunchesHoldingIdentity(
  matches: (identity: string) => boolean,
  request?: StructuredLaunchRequest
): StructuredLaunchState[] {
  return [...structuredLaunchStates()].filter(
    (state) => matches(state.identity) && holdsLaunchIdentity(state, request)
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
    attempt.request.text === '' &&
    request.text !== '' &&
    isStructuredLaunchChatEmpty(state.intent.sessionId)
    ? attempt
    : undefined
}

/** The launch a new start of `request` joins: one it repeats, else an empty chat it claims. The
 *  newest wins if a retried resume holds the identity too. */
export function getJoinableStructuredLaunchState(
  identity: string,
  request: StructuredLaunchRequest
): StructuredLaunchState | undefined {
  const matches = (candidate: string): boolean => candidate === identity
  return (
    structuredLaunchesHoldingIdentity(matches, request).at(-1) ??
    structuredLaunchesHoldingIdentity(matches).findLast((state) =>
      claimableStructuredLaunchAttempt(state, request)
    )
  )
}
