// Transitional: remove once no supported release lacks AGENT_SESSION_STATUS_AWAITS_USER_CAPABILITY.
//
// A summary's `status` is the main agent's own; a subagent's request rides `awaitsUserSince`. A
// client that predates the split reads only `status`, so the host publishes the pre-split summary
// to it at the RPC boundary only: `attention` whoever asked, dated as before. The feed and every
// in-process reader keep the canonical summary.

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

/** The summary a host published before the split: `attention`, dated by the oldest pending prompt
 *  when the session's own agent had none, and without the tool line and verdict that only a
 *  working or idle main agent carries. */
function legacySummary(summary: AgentSessionStatusSummary): AgentSessionStatusSummary {
  const { awaitsUserSince, ...canonical } = summary
  if (awaitsUserSince === undefined || summary.status === null) {
    return summary
  }
  if (summary.status === 'attention') {
    return canonical
  }
  const {
    toolName: _toolName,
    toolInput: _toolInput,
    turnOutcome: _turnOutcome,
    statusStartedAt: _statusStartedAt,
    ...rest
  } = canonical
  return { ...rest, status: 'attention', statusStartedAt: awaitsUserSince }
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
