import { describe, expect, it } from 'vitest'
import { agentSessionAccountHome } from './agent-session-account-home'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from './agent-session-record-stored-form'
import { agentSessionStoredAgents } from './agent-session-stored-agent'
import { CLAUDE_AND_CODEX_STORED_AGENTS } from './agent-session-stored-agent.test-fixture'

describe('agent session account home', () => {
  it('stores the variable and path exactly as older builds wrote them', () => {
    expect(
      JSON.stringify(
        agentSessionAccountHome({ accountHomeVariable: 'CODEX_HOME' }, '/home/dev/.codex')
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
      agentSessionStoredAgents([{ agent: 'claude' }, { agent: 'codex' }, { agent: 'codex' }])
    ).toThrow('registered twice')
  })
})
