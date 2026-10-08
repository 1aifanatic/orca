import { describe, expect, it } from 'vitest'
import { agentArgumentsDescription } from './agent-arguments-description'

describe('agentArgumentsDescription', () => {
  it.each([
    ['claude', '~/.claude/settings.json'],
    ['codex', '~/.codex/config.toml'],
    ['grok', '~/.grok/config.toml'],
    ['opencode', '~/.config/opencode/opencode.json']
  ] as const)('tells %s users where chat settings go instead', (agent, configFile) => {
    expect(agentArgumentsDescription(agent)).toContain("Structured chats don't use these")
    expect(agentArgumentsDescription(agent)).toContain(configFile)
  })

  it('names no file for an agent whose config Orca has not verified', () => {
    expect(agentArgumentsDescription('omp')).toBe(
      "Used when OMP runs in a terminal, including terminal chats. Structured chats don't use these."
    )
  })

  // Agents with only terminal chats launch with these Arguments everywhere.
  it('says nothing for an agent with no structured chat', () => {
    expect(agentArgumentsDescription('gemini')).toBeUndefined()
  })
})
