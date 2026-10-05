import { describe, expect, it } from 'vitest'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { CLAUDE_AND_CODEX_STORED_AGENTS } from '../../shared/agent-session-stored-agent.test-fixture'
import {
  CLAUDE_STRUCTURED_HANDLE_NAMESPACE,
  CODEX_STRUCTURED_HANDLE_NAMESPACE
} from '../../shared/agent-session-provider-handle-encoding'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  STRUCTURED_AGENT_STORAGE
} from './structured-agent-runtime-registrations'

describe('what the shipped definitions let a record store', () => {
  it('pins what every older build wrote', () => {
    expect(CLAUDE_STRUCTURED_AGENT).toMatchObject({
      handleTransport: CLAUDE_STRUCTURED_HANDLE_NAMESPACE.transport,
      accountHomeVariable: 'CLAUDE_CONFIG_DIR'
    })
    expect(CODEX_STRUCTURED_AGENT).toMatchObject({
      handleTransport: CODEX_STRUCTURED_HANDLE_NAMESPACE.transport,
      accountHomeVariable: 'CODEX_HOME'
    })
  })

  it('admits exactly the agents the runtime routes, stored as before', () => {
    expect([...STRUCTURED_AGENT_STORAGE.keys()]).toEqual(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(({ definition }) => definition.agent)
    )
    // Claude and Codex keep the storage every older build wrote; Grok's is new and its own.
    expect(new Map([...STRUCTURED_AGENT_STORAGE].filter(([agent]) => agent !== 'grok'))).toEqual(
      CLAUDE_AND_CODEX_STORED_AGENTS
    )
    expect(STRUCTURED_AGENT_STORAGE.get('grok')).toEqual({
      agent: 'grok',
      handleTransport: 'acp',
      accountHomeVariable: 'GROK_HOME'
    })
  })
})
