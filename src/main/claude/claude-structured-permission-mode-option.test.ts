import { describe, expect, it, vi } from 'vitest'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { sessionFor } from './claude-structured-dispatch-test-support'
import { setClaudeStructuredOption } from './claude-structured-options'
import { claudeStructuredSessionOptionsFrom } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import { claudeStructuredSpawnOptions } from './claude-structured-spawn-options'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'

function permissionSession(launchPermissionMode?: AgentChatPermissionMode) {
  const session = sessionFor()
  const setPermissionMode = vi.fn<ClaudeSession['connection']['setPermissionMode']>(
    async () => undefined
  )
  Object.assign(session.connection, { setPermissionMode })
  if (launchPermissionMode) {
    session.launchPermissionMode = launchPermissionMode
  }
  const write = (value: string) =>
    setClaudeStructuredOption(session, { key: 'permissionMode', value }, 50)
  return { session, setPermissionMode, write }
}

describe('a Claude chat permission-mode write', () => {
  it('applies a chat mode live as the CLI mode of the same meaning', async () => {
    const s = permissionSession('ask')

    await expect(s.write('accept-edits')).resolves.toMatchObject({ permissionMode: 'accept-edits' })
    await s.write('auto')

    expect(s.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['acceptEdits', 'auto'])
    expect(s.session.options.get('permissionMode')).toBe('auto')
  })

  // The CLI refuses this control request on a child launched without the flag, so none is sent;
  // the choice is kept and the host relaunches before the next send.
  it('keeps Full access for a relaunch on a child launched without the bypass flag', async () => {
    const s = permissionSession('ask')

    await expect(s.write('bypass')).resolves.toMatchObject({ permissionMode: 'bypass' })

    expect(s.setPermissionMode).not.toHaveBeenCalled()
    expect(claudeStructuredSessionOptionsFrom(s.session, null).permissionModes).toEqual({
      current: 'bypass',
      supported: ['ask', 'accept-edits', 'auto', 'bypass']
    })
  })

  it('moves a child launched with the flag in and out of Full access live', async () => {
    const s = permissionSession('bypass')

    await s.write('ask')
    await s.write('bypass')

    expect(s.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'default',
      'bypassPermissions'
    ])
  })

  it('refuses a value that is not a chat mode, and a CLI refusal, without recording either', async () => {
    const s = permissionSession('ask')
    await expect(s.write('bypassPermissions')).rejects.toThrow(/no permission mode/)

    s.setPermissionMode.mockRejectedValueOnce(
      new ClaudeControlRequestError('set_permission_mode', 'Cannot transition to auto mode')
    )
    await expect(s.write('auto')).rejects.toThrow(/auto mode/)
    expect(s.session.options.has('permissionMode')).toBe(false)
  })
})

describe('a Claude chat permission mode across a restart', () => {
  it.each([
    ['ask', 'default'],
    ['accept-edits', 'acceptEdits'],
    ['auto', 'auto']
  ] as const)('starts the stored %s chat mode as %s without a restore request', (mode, sdkMode) => {
    const spawn = claudeStructuredSpawnOptions({
      launch: { options: CLAUDE_STRUCTURED_BASE_OPTIONS, resumesTranscript: true },
      saved: { model: 'sonnet', permissionMode: mode }
    })
    expect(spawn.sdkOptions.permissionMode).toBe(sdkMode)
    expect(spawn.options.get('permissionMode')).toBe(mode)
    expect(spawn.skipped).toEqual([])
  })

  // The chat's mode is its own: switching models never touches it.
  it('keeps the chat mode through a model switch', async () => {
    const s = permissionSession('ask')
    Object.assign(s.session.connection, {
      setModel: async () => undefined,
      supportedModels: async () => []
    })
    await s.write('accept-edits')

    await setClaudeStructuredOption(s.session, { key: 'model', value: 'opus' }, 50)

    expect(claudeStructuredSessionOptionsFrom(s.session, null).permissionModes?.current).toBe(
      'accept-edits'
    )
  })

  it('reports the mode the child was launched for when the chat never picked', () => {
    const s = permissionSession('bypass')
    expect(claudeStructuredSessionOptionsFrom(s.session, null).permissionModes?.current).toBe(
      'bypass'
    )
  })
})
