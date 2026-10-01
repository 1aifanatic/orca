// Why: a status summary's `status` is the main agent's own, and `awaitsUser` says a subagent asked.
// A reader that predates the split reads only `status`, so it is sent `attention` for either ask.
export const AGENT_SESSION_STATUS_AWAITS_USER_CAPABILITY =
  'agent-session.status-awaits-user.v1' as const
