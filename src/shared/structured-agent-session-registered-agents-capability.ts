// Why: a host's structured agents are the ones it registered, not a list every build ships. A host
// advertising this accepts any agent it lists through `agentSession.agents` (with each agent's
// capability record) in `agentSession.*` params, and refuses one it did not register; a client
// offers an agent beyond Claude and Codex only to such a host. A client advertising it renders an
// `agent-session` tab of any agent its host lists; the host withholds every other agent's tabs from
// a client that does not (an older client would list them with an empty pane).
export const STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY =
  'agent-session.structured.registered-agents.v1' as const
