import { describe, expect, it } from 'vitest'
import {
  agentHasPermissionMode,
  agentPermissionOptionNames,
  applyAgentPermissionModeToAll,
  normalizeAgentPermissionModeOverrides,
  resolveAgentPermissionMode,
  resolveDefaultAgentPermissionMode
} from './tui-agent-permissions'

describe('tui agent permissions', () => {
  it('defaults an untouched profile to bypass, as Orca has always shipped', () => {
    expect(resolveDefaultAgentPermissionMode({})).toBe('bypass')
    expect(resolveAgentPermissionMode('claude', undefined)).toBe('bypass')
  })

  it('prefers the agent override over the shared default', () => {
    const settings = {
      agentPermissionMode: 'ask' as const,
      agentPermissionModeOverrides: { codex: 'bypass' as const }
    }
    expect(resolveAgentPermissionMode('codex', settings)).toBe('bypass')
    expect(resolveAgentPermissionMode('claude', settings)).toBe('ask')
  })

  it('applies one mode to every agent and clears per-agent choices', () => {
    expect(applyAgentPermissionModeToAll('ask')).toEqual({
      agentPermissionMode: 'ask',
      agentPermissionModeOverrides: {}
    })
  })

  it('drops unknown agents and modes from stored overrides', () => {
    expect(
      normalizeAgentPermissionModeOverrides({ claude: 'ask', nope: 'bypass', codex: 'yolo' })
    ).toEqual({ claude: 'ask' })
    expect(normalizeAgentPermissionModeOverrides('bad')).toEqual({})
  })

  it('knows which agents have a permission mode at all', () => {
    expect(agentHasPermissionMode('claude')).toBe(true)
    expect(agentHasPermissionMode('goose')).toBe(true)
    expect(agentHasPermissionMode('opencode')).toBe(false)
  })

  it('names the options that change an agent permission posture', () => {
    expect(agentPermissionOptionNames('claude')).toEqual([
      '--dangerously-skip-permissions',
      '--permission-mode',
      '--allow-dangerously-skip-permissions'
    ])
    expect(agentPermissionOptionNames('grok')).toEqual(['--permission-mode'])
    expect(agentPermissionOptionNames('goose')).toEqual([])
  })
})
