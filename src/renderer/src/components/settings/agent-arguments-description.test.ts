import { describe, expect, it } from 'vitest'
import { agentArgumentsDescription } from './agent-arguments-description'

describe('agentArgumentsDescription', () => {
  it.each([
    ['claude', 'Claude', '~/.claude/settings.json'],
    ['codex', 'Codex', '~/.codex/config.toml'],
    ['grok', 'Grok', '~/.grok/config.toml'],
    ['opencode', 'OpenCode', '~/.config/opencode/opencode.json']
  ] as const)('tells %s users where native chat settings go instead', (agent, name, configFile) => {
    expect(agentArgumentsDescription(agent)).toBe(
      `Used when ${name} CLI is launched. Native chat does not use these; put its settings in ${configFile}.`
    )
  })

  it('names no file for an agent whose config Orca has not verified', () => {
    expect(agentArgumentsDescription('omp')).toBe(
      'Used when OMP CLI is launched. Native chat does not use these.'
    )
  })

  // Agents with only terminal chats launch with these Arguments everywhere.
  it('says nothing for an agent without a native chat', () => {
    expect(agentArgumentsDescription('gemini')).toBeUndefined()
  })
})
