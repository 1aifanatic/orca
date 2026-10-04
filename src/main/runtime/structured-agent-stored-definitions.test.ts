import { describe, expect, it } from 'vitest'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { CLAUDE_AND_CODEX_STORED_AGENTS } from '../../shared/agent-session-stored-agent.test-fixture'

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
})
