// Whether a chat's loaded journal is the host's as of now, or only what was left of it when
// contact was lost. Anything the journal alone decides (a message handed back because no row
// shows it) waits for a live one: losing contact is no evidence that the host holds nothing.

import {
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

/** What the read side applies: the reducer's actions, and the subscription closing or failing. */
export type StructuredAgentSessionReadAction = StructuredAgentSessionAction | { type: 'detached' }

/** Any frame of the subscription makes the journal live; its end, a failure, a reload or a
 *  closed stream ends that. A page read on its own changes nothing. */
function liveAfter(
  state: StructuredAgentSessionState,
  action: StructuredAgentSessionReadAction
): boolean {
  if (action.type === 'event') {
    return action.event.type !== 'end'
  }
  if (action.type === 'detached' || action.type === 'loading' || action.type === 'error') {
    return false
  }
  return state.live === true
}

/** The reducer's answer to `action`, with whether the journal is live after it. */
export function reduceStructuredAgentSessionRead(
  state: StructuredAgentSessionState,
  action: StructuredAgentSessionReadAction,
  receivedAt: number
): StructuredAgentSessionState {
  const next =
    action.type === 'detached' ? state : reduceStructuredAgentSession(state, action, receivedAt)
  const live = liveAfter(state, action)
  return (next.live === true) === live ? next : { ...next, live }
}

/** Whether the journal alone may settle a message now: read live, attached and ready. */
export function structuredAgentSessionJournalIsLive(state: StructuredAgentSessionState): boolean {
  return state.live === true && state.status === 'ready' && state.fence !== null
}
