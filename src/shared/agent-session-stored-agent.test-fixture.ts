import { agentSessionStoredAgents } from './agent-session-stored-agent'

/** The agents every older build's record store admitted; a runtime test pins the shipped list to it. */
export const CLAUDE_AND_CODEX_STORED_AGENTS = agentSessionStoredAgents([
  { agent: 'claude' },
  { agent: 'codex' }
])
