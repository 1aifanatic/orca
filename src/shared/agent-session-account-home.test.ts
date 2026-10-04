import { describe, expect, it } from 'vitest'
import { agentSessionAccountHome } from './agent-session-account-home'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from './agent-session-record-stored-form'
import {
  agentSessionStoredAgents,
  isDeclaredAccountHomeVariable
} from './agent-session-stored-agent'
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

  it('admits only a variable a registered agent declares', () => {
    expect(isDeclaredAccountHomeVariable(CLAUDE_AND_CODEX_STORED_AGENTS, 'CLAUDE_CONFIG_DIR')).toBe(
      true
    )
    expect(isDeclaredAccountHomeVariable(CLAUDE_AND_CODEX_STORED_AGENTS, 'CODEX_HOME')).toBe(true)
    expect(isDeclaredAccountHomeVariable(CLAUDE_AND_CODEX_STORED_AGENTS, 'PATH')).toBe(false)
    expect(isDeclaredAccountHomeVariable(CLAUDE_AND_CODEX_STORED_AGENTS, undefined)).toBe(false)
    const withGrok = agentSessionStoredAgents([
      ...CLAUDE_AND_CODEX_STORED_AGENTS.values(),
      { agent: 'grok', handleTransport: 'acp', accountHomeVariable: 'GROK_HOME' }
    ])
    expect(isDeclaredAccountHomeVariable(withGrok, 'GROK_HOME')).toBe(true)
    expect(isDeclaredAccountHomeVariable(CLAUDE_AND_CODEX_STORED_AGENTS, 'GROK_HOME')).toBe(false)
  })

  it('refuses a stored record whose account home names an undeclared variable', () => {
    const record = encodeAgentSessionRecord(agentSessionRecordFixture())
    expect(isPersistedAgentSessionRecord(record, CLAUDE_AND_CODEX_STORED_AGENTS)).toBe(true)
    expect(
      isPersistedAgentSessionRecord(
        { ...record, accountHome: { variable: 'LD_PRELOAD', path: '/tmp/x' } },
        CLAUDE_AND_CODEX_STORED_AGENTS
      )
    ).toBe(false)
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
