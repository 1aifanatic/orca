// A close re-asks the adapter for a failed start's owner the record still names
// (`releaseUnprovenOwner`). An adapter acts only on a child it still holds in memory: one it holds
// nothing for stops nothing, spawns nothing and reports nothing (as after an Orca restart, where
// the record names an old pid); one still holding the child a failed cleanup left closes it again.

import { describe, expect, it, vi } from 'vitest'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from '../../claude/claude-structured-session-state'
import {
  adapterFor as claudeAdapterFor,
  fakeClaude,
  identityFor as claudeIdentityFor,
  recordingJournalSink
} from '../../claude/claude-structured-session-test-support'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  adapterFor as codexAdapterFor,
  fakeCodex,
  identityFor as codexIdentityFor
} from '../../codex/codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionEvent } from '../../codex/codex-structured-session-state'
import { claudeAndCodexRouter } from './structured-agent-session-adapter-router-test-support'

describe('a close re-asking for an owner the adapter never held', () => {
  it('stops nothing for Claude', async () => {
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

  it('stops nothing for Codex', async () => {
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

describe('a close re-asking for an owner whose failed cleanup the adapter still holds', () => {
  it('closes the Claude child again, as a close Orca asked for, and keeps its handle', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persisted: unknown[] = []
    const router = claudeAndCodexRouter(
      {
        claude: claudeAdapterFor(claude, {}, events, persisted),
        // The router's fan-out asks it too; it holds nothing.
        codex: codexAdapterFor(fakeCodex())
      },
      async () => {}
    )
    await router.acquire({
      identity: claudeIdentityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recordingJournalSink()
    })
    const connection = claude.connections[0]!
    const close = vi.spyOn(connection, 'close').mockResolvedValueOnce(false)
    // The host could not commit the start, and its cleanup could not prove the child gone.
    expect(await router.releaseAcquisition({ sessionId: 'session-1' }).catch(() => false)).toBe(
      false
    )
    const before = { events: events.length, persisted: persisted.length }
    expect(await router.releaseAcquisition({ sessionId: 'session-1' })).toBe(true)
    expect(close).toHaveBeenCalledTimes(2)
    // The handle of the conversation the child ran, so the next send resumes it.
    expect(events.slice(before.events).map((event) => event.type)).toEqual(['ended', 'handle'])
    expect(events[before.events]).toMatchObject({ cause: 'requested-close' })
    expect(persisted).toHaveLength(before.persisted + 1)
  })

  it('closes the Codex child again, as a close Orca asked for', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const router = claudeAndCodexRouter(
      {
        claude: claudeAdapterFor(fakeClaude()),
        codex: codexAdapterFor(codex, {}, events)
      },
      async () => {}
    )
    await router.acquire({ identity: codexIdentityFor('session-1'), fence: 7, spawnToken: 's-9' })
    const connection = codex.connections[0]!
    const close = vi.spyOn(connection, 'close').mockResolvedValueOnce(false)
    expect(await router.releaseAcquisition({ sessionId: 'session-1' }).catch(() => false)).toBe(
      false
    )
    const before = events.length
    expect(await router.releaseAcquisition({ sessionId: 'session-1' })).toBe(true)
    expect(close).toHaveBeenCalledTimes(2)
    expect(events.slice(before).filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'requested-close' }
    ])
  })
})
