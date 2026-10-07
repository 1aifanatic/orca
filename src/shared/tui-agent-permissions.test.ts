import { describe, expect, it } from 'vitest'
import {
  agentHasPermissionMode,
  agentPermissionModes,
  PERMISSION_AGENT_IDS,
  normalizeAgentPermissionSettingsUpdate,
  normalizeAgentPermissionModeOverrides,
  resolveAgentPermissionMode,
  resolveDefaultAgentPermissionMode,
  type AgentPermissionSettingsFields
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

  // A mode a newer build wrote stays stored for it.
  it('drops unknown agents but keeps every stored mode', () => {
    expect(
      normalizeAgentPermissionModeOverrides({
        claude: 'ask',
        nope: 'bypass',
        codex: 'yolo',
        gemini: 1
      })
    ).toEqual({ claude: 'ask', codex: 'yolo' })
    expect(normalizeAgentPermissionModeOverrides('bad')).toEqual({})
  })

  it('knows which agents have a permission mode at all', () => {
    expect(agentHasPermissionMode('claude')).toBe(true)
    expect(agentHasPermissionMode('goose')).toBe(true)
    expect(agentHasPermissionMode('opencode')).toBe(false)
  })

  // A newer build may store a mode this one doesn't know; it fails toward more prompts.
  it('reads a stored mode it does not know as ask', () => {
    const settings: AgentPermissionSettingsFields = JSON.parse(
      '{"agentPermissionMode":"future-mode"}'
    )
    expect(resolveDefaultAgentPermissionMode(settings)).toBe('ask')
    expect(resolveAgentPermissionMode('claude', settings)).toBe('ask')
    expect(
      resolveAgentPermissionMode('codex', {
        ...settings,
        agentPermissionModeOverrides: { codex: 'bypass' }
      })
    ).toBe('bypass')
    expect(
      resolveAgentPermissionMode('codex', {
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: { codex: 'accept-edits' }
      })
    ).toBe('ask')
  })

  it.each(['ask', 'bypass', 'accept-edits', 'auto'] as const)(
    'keeps the stored %s mode',
    (mode) => {
      const settings = { agentPermissionMode: mode, agentPermissionModeOverrides: { claude: mode } }
      expect(normalizeAgentPermissionSettingsUpdate(settings)).toEqual(settings)
      expect(resolveDefaultAgentPermissionMode(settings)).toBe(mode)
      expect(resolveAgentPermissionMode('claude', settings)).toBe(mode)
    }
  )

  it('offers intermediate modes only for agents with verified equivalents', () => {
    for (const agent of PERMISSION_AGENT_IDS) {
      const modes = agentPermissionModes(agent)
      expect(modes).toEqual(
        agent === 'claude'
          ? ['ask', 'accept-edits', 'auto', 'bypass']
          : agent === 'codex'
            ? ['ask', 'auto', 'bypass']
            : ['ask', 'bypass']
      )
      for (const mode of ['accept-edits', 'auto'] as const) {
        expect(resolveAgentPermissionMode(agent, { agentPermissionMode: mode })).toBe(
          modes.includes(mode) ? mode : 'ask'
        )
      }
    }
    expect(agentPermissionModes('opencode')).toEqual([])
  })
})
