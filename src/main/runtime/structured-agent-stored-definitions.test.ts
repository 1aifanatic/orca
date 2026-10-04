import { describe, expect, it } from 'vitest'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { CLAUDE_AND_CODEX_STORED_AGENTS } from '../../shared/agent-session-stored-agent.test-fixture'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  STRUCTURED_AGENT_STORAGE
} from './structured-agent-runtime-registrations'

describe('what the shipped definitions let a record store', () => {
  it('matches the storage every older build wrote', () => {
    for (const definition of [CLAUDE_STRUCTURED_AGENT, CODEX_STRUCTURED_AGENT]) {
      const { agent, handleTransport, accountHomeVariable } = definition
      expect({ agent, handleTransport, accountHomeVariable }).toEqual(
        CLAUDE_AND_CODEX_STORED_AGENTS.get(agent)
      )
    }
    expect(CLAUDE_STRUCTURED_AGENT.accountHomeVariable).toBe('CLAUDE_CONFIG_DIR')
    expect(CODEX_STRUCTURED_AGENT.accountHomeVariable).toBe('CODEX_HOME')
  })

  it('admits exactly the agents the runtime routes, stored as before', () => {
    expect([...STRUCTURED_AGENT_STORAGE.keys()]).toEqual(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(({ definition }) => definition.agent)
    )
    expect(STRUCTURED_AGENT_STORAGE).toEqual(CLAUDE_AND_CODEX_STORED_AGENTS)
  })
})
