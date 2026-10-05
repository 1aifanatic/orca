// A close re-asks the adapter for a failed start's owner the record still names
// (`releaseUnprovenOwner`). For Claude and Codex, which hold no such child, that ask stops nothing,
// spawns nothing and reports nothing: as after an Orca restart, where the record names an old pid.

import { describe, expect, it, vi } from 'vitest'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'

describe('a close re-asking for an owner the adapter never held', () => {
  it('is a no-op for Claude', async () => {
    const openConnection = vi.fn(async () => {
      throw new Error('no Claude may start')
    })
    const onEvent = vi.fn()
    const persistHandle = vi.fn(async () => {})
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch: async () => {
        throw new Error('no Claude may launch')
      },
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      onEvent,
      persistHandle
    })
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(openConnection).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
    expect(persistHandle).not.toHaveBeenCalled()
  })

  it('is a no-op for Codex', async () => {
    const openConnection = vi.fn(async () => {
      throw new Error('no Codex may start')
    })
    const onEvent = vi.fn()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => {
        throw new Error('no Codex may launch')
      },
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      onEvent
    })
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(openConnection).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
  })
})
