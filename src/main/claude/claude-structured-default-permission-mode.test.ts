import { describe, expect, it, vi } from 'vitest'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { ClaudeControlRequestTimeoutError } from './claude-agent-sdk-control-requests'
import { claudeStructuredPermissionOptions } from './claude-structured-permission-mode'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }

describe('Claude inherited permission defaults', () => {
  it('keeps an unanswered inherited mode unconfirmed without failing startup', async () => {
    const claude = fakeClaude({
      routes: {
        set_permission_mode: () => {
          throw new ClaudeControlRequestTimeoutError('set_permission_mode')
        }
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = adapterAtPublishFor(claude, {
      permissionMode: 'auto',
      options: claudeStructuredPermissionOptions('auto')
    })
    try {
      await adapter.acquire(ACQUIRE)
      await adapter.awaitOptionWritable('session-1')
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).permissionModes?.current
      ).toBe('auto')
      expect(adapter.readOptionRestoreFailures('session-1')).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('keeping it unconfirmed'))
    } finally {
      await adapter.closeAll()
      warn.mockRestore()
    }
  })

  it.each(['accept-edits', 'auto'] as const)(
    'applies %s before startup completes',
    async (mode) => {
      const claude = fakeClaude()
      const adapter = adapterAtPublishFor(claude, {
        permissionMode: mode,
        options: claudeStructuredPermissionOptions(mode)
      })
      try {
        await adapter.acquire(ACQUIRE)
        await adapter.awaitOptionWritable('session-1')
        expect(claude.connections[0]?.calls).toContainEqual({
          subtype: 'set_permission_mode',
          params: { mode: mode === 'auto' ? 'auto' : 'acceptEdits' }
        })
        expect(
          (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).permissionModes?.current
        ).toBe(mode)
        expect(claude.connections[0]?.sent).toEqual([])
      } finally {
        await adapter.closeAll()
      }
    }
  )

  it('keeps a chat choice ahead of the inherited default', async () => {
    const claude = fakeClaude()
    const adapter = adapterAtPublishFor(claude, {
      permissionMode: 'auto',
      options: claudeStructuredPermissionOptions('auto')
    })
    try {
      await adapter.acquire({ ...ACQUIRE, options: { permissionMode: 'ask' } })
      await adapter.awaitOptionWritable('session-1')
      expect(
        claude.connections[0]?.calls.filter((call) => call.subtype === 'set_permission_mode')
      ).toEqual([])
      expect(claude.connections[0]?.launch.options.permissionMode).toBe('default')
    } finally {
      await adapter.closeAll()
    }
  })

  it('uses Ask when the selected model reports no auto support', async () => {
    const claude = fakeClaude({
      initModels: [
        { value: 'default', resolvedModel: 'claude-sonnet-5' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5', supportsAutoMode: false }
      ]
    })
    const adapter = adapterAtPublishFor(claude, {
      permissionMode: 'auto',
      options: claudeStructuredPermissionOptions('auto')
    })
    try {
      await adapter.acquire(ACQUIRE)
      await adapter.awaitOptionWritable('session-1')
      expect(claude.connections[0]?.calls).toContainEqual({
        subtype: 'set_permission_mode',
        params: { mode: 'default' }
      })
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).permissionModes
      ).toMatchObject({ current: 'ask' })
    } finally {
      await adapter.closeAll()
    }
  })

  it('applies Ask when the CLI explicitly refuses the inherited mode', async () => {
    const claude = fakeClaude({
      routes: {
        set_permission_mode: (params) => {
          if (params?.mode === 'auto') {
            throw new ClaudeControlRequestError(
              'set_permission_mode',
              'Cannot transition to auto mode'
            )
          }
        }
      }
    })
    const adapter = adapterAtPublishFor(claude, {
      permissionMode: 'auto',
      options: claudeStructuredPermissionOptions('auto')
    })
    try {
      await adapter.acquire(ACQUIRE)
      await adapter.awaitOptionWritable('session-1')
      expect(
        claude.connections[0]?.calls.filter((call) => call.subtype === 'set_permission_mode')
      ).toEqual([
        { subtype: 'set_permission_mode', params: { mode: 'auto' } },
        { subtype: 'set_permission_mode', params: { mode: 'default' } }
      ])
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).permissionModes?.current
      ).toBe('ask')
    } finally {
      await adapter.closeAll()
    }
  })
})
