import {
  CLAUDE_STRUCTURED_HANDLE_NAMESPACE,
  CODEX_STRUCTURED_HANDLE_NAMESPACE
} from './agent-session-provider-handle-encoding'
import { agentSessionStoredAgents } from './agent-session-stored-agent'

/** What the shipped Claude and Codex definitions declare; a runtime test pins them equal. */
export const CLAUDE_AND_CODEX_STORED_AGENTS = agentSessionStoredAgents([
  {
    agent: 'claude',
    handleTransport: CLAUDE_STRUCTURED_HANDLE_NAMESPACE.transport,
    accountHomeVariable: 'CLAUDE_CONFIG_DIR'
  },
  {
    agent: 'codex',
    handleTransport: CODEX_STRUCTURED_HANDLE_NAMESPACE.transport,
    accountHomeVariable: 'CODEX_HOME'
  }
])
