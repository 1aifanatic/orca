import { describe, expect, it } from 'vitest'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }

describe('Claude inherited permission defaults', () => {
  it.each(['accept-edits', 'auto'] as const)(
    'applies %s before startup completes',
    async (mode) => {
      const claude = fakeClaude()
      const adapter = adapterAtPublishFor(claude, { permissionMode: mode })
      try {
        await adapter.acquire(ACQUIRE)
        await adapter.awaitStarted('session-1')
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
    const adapter = adapterAtPublishFor(claude, { permissionMode: 'auto' })
    try {
      await adapter.acquire({ ...ACQUIRE, options: { permissionMode: 'ask' } })
      await adapter.awaitStarted('session-1')
      expect(
        claude.connections[0]?.calls.filter((call) => call.subtype === 'set_permission_mode')
      ).toEqual([{ subtype: 'set_permission_mode', params: { mode: 'default' } }])
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
    const adapter = adapterAtPublishFor(claude, { permissionMode: 'auto' })
    try {
      await adapter.acquire(ACQUIRE)
      await adapter.awaitStarted('session-1')
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
    const adapter = adapterAtPublishFor(claude, { permissionMode: 'auto' })
    try {
      await adapter.acquire(ACQUIRE)
      await adapter.awaitStarted('session-1')
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
