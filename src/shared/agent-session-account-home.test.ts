import { describe, expect, it } from 'vitest'
import { agentSessionAccountHome } from './agent-session-account-home'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from './agent-session-record-stored-form'
import { agentSessionStoredAgents } from './agent-session-stored-agent'
import { CLAUDE_AND_CODEX_STORED_AGENTS } from './agent-session-stored-agent.test-fixture'

describe('agent session account home', () => {
  it('pins the variables older builds wrote and read', () => {
    expect(CLAUDE_AND_CODEX_STORED_AGENTS.get('claude')?.accountHomeVariable).toBe(
      'CLAUDE_CONFIG_DIR'
    )
    expect(CLAUDE_AND_CODEX_STORED_AGENTS.get('codex')?.accountHomeVariable).toBe('CODEX_HOME')
    expect(
      JSON.stringify(
        agentSessionAccountHome(CLAUDE_AND_CODEX_STORED_AGENTS.get('codex')!, '/home/dev/.codex')
      )
    ).toBe('{"variable":"CODEX_HOME","path":"/home/dev/.codex"}')
  })

  // Whether the variable is the record's own agent's is decided when its agent would start, since
  // it becomes the child's environment (structured-agent-session-drivability.test.ts).
  it('reads any well-formed variable, and sets aside one that is not a variable name', () => {
    const record = encodeAgentSessionRecord(agentSessionRecordFixture())
    const withVariable = (variable: string) =>
      isPersistedAgentSessionRecord(
        { ...record, accountHome: { variable, path: '/tmp/x' } },
        CLAUDE_AND_CODEX_STORED_AGENTS
      )
    expect(withVariable('CODEX_HOME')).toBe(true)
    expect(withVariable('GROK_HOME')).toBe(true)
    for (const malformed of ['', 'A B', '1HOME', 'HOME=x', 'X'.repeat(129)]) {
      expect(withVariable(malformed)).toBe(false)
    }
  })

  it('refuses registering one agent twice', () => {
    expect(() =>
      agentSessionStoredAgents([
        ...CLAUDE_AND_CODEX_STORED_AGENTS.values(),
        { agent: 'codex', handleTransport: 'acp', accountHomeVariable: 'CODEX_HOME' }
      ])
    ).toThrow('registered twice')
  })
})
