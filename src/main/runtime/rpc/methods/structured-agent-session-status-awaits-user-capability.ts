// Transitional: remove once no supported release lacks AGENT_SESSION_STATUS_AWAITS_USER_CAPABILITY.
//
// A summary's `status` is the main agent's own; a subagent's request rides `awaitsUser`. A client
// that predates the split reads only `status`, so the host publishes the pre-split summary to it
// at the RPC boundary only: `attention` whoever asked. The feed and every in-process reader keep
// the canonical summary.

import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_STATUS_AWAITS_USER_CAPABILITY } from '../../../../shared/agent-session-status-awaits-user-capability'
import type { RpcContext } from '../core'

type StatusReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function readsAwaitsUser(ctx: StatusReader): boolean {
  // An in-process caller is this build; only a negotiated client can predate the split.
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_STATUS_AWAITS_USER_CAPABILITY) === true
  )
}

/** The fields an `attention` summary never carries go with the main agent's own state: a tool line
 *  is a working turn's, a verdict an idle one's, and the clock dated the state replaced here. */
function legacySummary(summary: AgentSessionStatusSummary): AgentSessionStatusSummary {
  if (!summary.awaitsUser || summary.status === null || summary.status === 'attention') {
    return summary
  }
  const {
    toolName: _toolName,
    toolInput: _toolInput,
    turnOutcome: _turnOutcome,
    statusStartedAt: _statusStartedAt,
    ...rest
  } = summary
  return { ...rest, status: 'attention' }
}

export function projectStatusAwaitsUserEvent(
  event: AgentSessionStatusEvent,
  ctx: StatusReader
): AgentSessionStatusEvent {
  if (readsAwaitsUser(ctx)) {
    return event
  }
  if (event.type === 'status') {
    const session = legacySummary(event.session)
    return session === event.session ? event : { ...event, session }
  }
  if (event.type === 'snapshot') {
    const sessions = event.sessions.map(legacySummary)
    return sessions.every((session, index) => session === event.sessions[index])
      ? event
      : { ...event, sessions }
  }
  return event
}
