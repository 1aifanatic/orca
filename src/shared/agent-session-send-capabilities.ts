// What a structured send's reply means to the client that asked, negotiated per client: each later
// client reads more of the host's answer on its own, so the host holds less of it back.

// Why: older structured clients render durable pending replies as uncertain delivery. Capable
// clients skip the host's bounded best-effort settlement observation.
export const AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY =
  'agent-session.pending-send-result.v1' as const
// Why: a send is now answered once the host accepts it, before any agent has it. A client without
// this cannot show a message rejected after that answer, so the host holds its reply until the
// message is handed over or rejected. Transitional: drop the hold once no supported desktop or
// mobile client lacks the capability; mobile must first show a rejected message in place.
export const AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY =
  'agent-session.accepted-send.v1' as const
// Why: a chat's first message now starts its agent, after the host accepts it. A client with this
// follows a send to its final state before writing outward (notes cleared, review replies posted);
// one with only `accepted-send` reads `pending` as delivered, so the host holds that one's reply
// past the start, up to a cap. Temporary: drop the hold once no supported desktop lacks this.
export const AGENT_SESSION_SEND_FINAL_STATE_RUNTIME_CAPABILITY =
  'agent-session.send-final-state.v1' as const

/** The host side: it answers pending sends, and accepts a send before any agent has it. */
export const AGENT_SESSION_SEND_HOST_CAPABILITIES = [
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY
] as const

/** What a desktop reads of a send's reply, advertised to a remote host. */
export const AGENT_SESSION_SEND_CLIENT_CAPABILITIES = [
  ...AGENT_SESSION_SEND_HOST_CAPABILITIES,
  AGENT_SESSION_SEND_FINAL_STATE_RUNTIME_CAPABILITY
] as const
