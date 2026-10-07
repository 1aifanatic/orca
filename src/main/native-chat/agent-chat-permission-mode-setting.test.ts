import { describe, expect, it } from 'vitest'
import { agentChatPermissionModeForSettings } from './agent-chat-permission-mode-setting'

describe('agentChatPermissionModeForSettings for Claude', () => {
  // The untouched case is the common one and the easiest to get wrong: a profile with no stored
  // mode gets the default Orca ships, which is bypass — what a terminal launch has always applied.
  it('bypasses when the user has never opened Agent settings', () => {
    expect(agentChatPermissionModeForSettings('claude', { agentDefaultArgs: {} })).toBe('bypass')
    expect(agentChatPermissionModeForSettings('claude', {})).toBe('bypass')
    expect(agentChatPermissionModeForSettings('claude', null)).toBe('bypass')
    expect(agentChatPermissionModeForSettings('claude', { agentDefaultArgs: { codex: '' } })).toBe(
      'bypass'
    )
  })

  it('bypasses in Yolo with or without extra arguments', () => {
    expect(
      agentChatPermissionModeForSettings('claude', {
        agentPermissionMode: 'bypass',
        agentDefaultArgs: { claude: '--model Opus' }
      })
    ).toBe('bypass')
  })

  // A terminal launch honours a bypass flag typed into Arguments, so the structured path does too.
  it('bypasses when the flag is typed into Arguments under Manual', () => {
    for (const claude of [
      '--dangerously-skip-permissions',
      '--dangerously-skip-permissions --model Opus',
      '--model Opus --dangerously-skip-permissions'
    ]) {
      expect(
        agentChatPermissionModeForSettings('claude', {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { claude }
        }),
        claude
      ).toBe('bypass')
    }
  })

  it('prompts in Manual, globally or for Claude alone', () => {
    expect(agentChatPermissionModeForSettings('claude', { agentPermissionMode: 'ask' })).toBe('ask')
    expect(
      agentChatPermissionModeForSettings('claude', {
        agentPermissionModeOverrides: { claude: 'ask' },
        agentDefaultArgs: { claude: '--model Opus' }
      })
    ).toBe('ask')
  })

  it('follows a Claude-only Yolo choice under a Manual default', () => {
    expect(
      agentChatPermissionModeForSettings('claude', {
        agentPermissionMode: 'ask',
        agentPermissionModeOverrides: { claude: 'bypass' }
      })
    ).toBe('bypass')
  })
})

describe('agentChatPermissionModeForSettings for Codex', () => {
  it('bypasses when the user has never opened Agent settings', () => {
    expect(agentChatPermissionModeForSettings('codex', { agentDefaultArgs: {} })).toBe('bypass')
    expect(agentChatPermissionModeForSettings('codex', {})).toBe('bypass')
    expect(agentChatPermissionModeForSettings('codex', null)).toBe('bypass')
    expect(agentChatPermissionModeForSettings('codex', { agentDefaultArgs: { claude: '' } })).toBe(
      'bypass'
    )
  })

  it('bypasses when the flag is typed into Arguments under Manual', () => {
    for (const codex of [
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol',
      '--model gpt-5.6-sol --dangerously-bypass-approvals-and-sandbox'
    ]) {
      expect(
        agentChatPermissionModeForSettings('codex', {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { codex }
        }),
        codex
      ).toBe('bypass')
    }
  })

  it('keeps quoted mentions and operands after -- in Manual', () => {
    for (const codex of [
      '--config "note=--dangerously-bypass-approvals-and-sandbox only as text"',
      '-- --dangerously-bypass-approvals-and-sandbox'
    ]) {
      expect(
        agentChatPermissionModeForSettings('codex', {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { codex }
        }),
        codex
      ).toBe('ask')
    }
  })

  it('asks under a Codex-only Manual choice', () => {
    expect(
      agentChatPermissionModeForSettings('codex', {
        agentPermissionModeOverrides: { codex: 'ask' }
      })
    ).toBe('ask')
  })

  it('follows the typed mode, not whether Arguments are custom', () => {
    expect(
      agentChatPermissionModeForSettings('codex', { agentDefaultArgs: { codex: '-m gpt-5.6-sol' } })
    ).toBe('bypass')
  })

  // The passthrough that used to carry these to app-server is gone on purpose; only the
  // permission posture is derived, and nothing else from the field reaches argv.
  it('carries nothing but the permission posture out of the arguments field', () => {
    expect(
      agentChatPermissionModeForSettings('codex', {
        agentPermissionMode: 'ask',
        agentDefaultArgs: {
          codex: '--profile review --add-dir /repo -c model_reasoning_effort=high'
        }
      })
    ).toBe('ask')
  })
})
