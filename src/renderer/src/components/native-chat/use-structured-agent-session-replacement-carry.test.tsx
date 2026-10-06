// @vitest-environment happy-dom

// A chat whose tab replaced another (a /clear) takes what this window still held for the old one:
// the composer's draft, and messages that never reached it. Derived from the host's tab link, so
// it holds whichever order the clear's reply and the tab move arrive in.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async () => null)
}))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  clearNativeChatComposerDraftIfUnchanged,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey as scope
} from './native-chat-composer-draft-store'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

const NO_ITEMS: readonly AgentJournalRenderItem[] = []
const CLEARED = "The chat was cleared before your message went out. It's back in the composer."

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

function pane(sessionId: string, options: { replaces?: string; cards?: readonly string[] } = {}) {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({
      journalItems: NO_ITEMS,
      sessionId,
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      composerScopeKey: scope(sessionId),
      queuedMessageIds: options.cards ?? [],
      ...(options.replaces ? { replacesSessionId: options.replaces } : {})
    })
  )
}

function entry(
  id: string,
  text: string,
  overrides: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: id,
      sessionId: 'old',
      text,
      attachments: [],
      queuedAt: Number(id.replace(/\D/g, '')) || 1
    }),
    ...overrides
  }
}

const REFUSED_AS_CLEARED = {
  kind: 'refused',
  code: 'agent_session_operation_invalid',
  details: { reason: 'conversationCleared' }
} as const

describe('the /clear the composer sent', () => {
  it('never starts the new chat, when the tab moves before the reply', () => {
    // The composer clears a command's text only once its reply lands.
    writeNativeChatDraftCache(scope('old'), '/clear')
    pane('new', { replaces: 'old' })
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    // The reply then lands on the old composer, which finds nothing to clear.
    clearNativeChatComposerDraftIfUnchanged(scope('old'), readNativeChatComposerDraft(scope('old')))
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
  })

  it('never starts the new chat, when the reply lands first', () => {
    writeNativeChatDraftCache(scope('old'), '/clear')
    clearNativeChatComposerDraftIfUnchanged(scope('old'), readNativeChatComposerDraft(scope('old')))
    pane('new', { replaces: 'old' })
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
  })
})

describe('a draft typed in the chat a /clear replaced', () => {
  it('comes along after what the new chat already holds, and leaves the old one', () => {
    writeNativeChatDraftCache(scope('old'), 'typed while the clear waited')
    writeNativeChatDraftCache(scope('new'), 'already here')
    pane('new', { replaces: 'old' })
    expect(readNativeChatDraftCache(scope('new'))).toBe(
      'already here\n\ntyped while the clear waited'
    )
    expect(readNativeChatDraftCache(scope('old'))).toBe('')
  })

  it('comes along for a pane first mounted on the new chat, and only once', () => {
    writeNativeChatDraftCache(scope('old'), 'saved before a reload')
    pane('new', { replaces: 'old' }).unmount()
    pane('new', { replaces: 'old' })
    expect(readNativeChatDraftCache(scope('new'))).toBe('saved before a reload')
  })
})

describe('messages this window held for the chat a /clear replaced', () => {
  it('come back to the composer in order, said once; none is sent again', async () => {
    commitStructuredAgentSessionOutbox('old', [
      entry('m1', 'refused as the clear ran', {
        state: 'rejected',
        lastAttemptAt: 2,
        lastFailure: REFUSED_AS_CLEARED
      }),
      entry('m2', 'still waiting behind it'),
      entry('m3', 'its answer was lost', { state: 'unconfirmed', lastAttemptAt: 3 })
    ])
    const { result } = pane('new', { replaces: 'old' })
    await waitFor(() => expect(getStructuredAgentSessionOutbox('old')).toEqual([]))
    expect(readNativeChatDraftCache(scope('new'))).toBe(
      'refused as the clear ran\n\nstill waiting behind it\n\nits answer was lost'
    )
    expect(result.current.error).toBe(CLEARED)
    expect(result.current.outbox).toEqual([])
  })

  it('leave without their text when the host has them: its row there, or its card here', async () => {
    commitStructuredAgentSessionOutbox('old', [
      entry('m1', 'recorded and rejected there', {
        state: 'rejected',
        lastAttemptAt: 2,
        lastFailure: { kind: 'rejected', reason: 'The provider refused it.' }
      }),
      entry('m2', 'carried as a card', { state: 'unconfirmed', lastAttemptAt: 3 })
    ])
    const { result } = pane('new', { replaces: 'old', cards: ['m2'] })
    await waitFor(() => expect(getStructuredAgentSessionOutbox('old')).toEqual([]))
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    expect(result.current.error).toBeNull()
  })

  it('a refusal that lands after the move comes to the new chat, said there once', async () => {
    const replacement = pane('new', { replaces: 'old' })
    expect(replacement.result.current.error).toBeNull()
    // The old pane's send settles after it unmounted: its refusal is written to the old outbox.
    act(() => {
      commitStructuredAgentSessionOutbox('old', [
        entry('m1', 'typed as the clear ran', {
          state: 'rejected',
          lastAttemptAt: 2,
          lastFailure: REFUSED_AS_CLEARED
        })
      ])
    })
    await waitFor(() =>
      expect(readNativeChatDraftCache(scope('new'))).toBe('typed as the clear ran')
    )
    expect(replacement.result.current.error).toBe(CLEARED)
    expect(getStructuredAgentSessionOutbox('old')).toEqual([])
  })

  it("a refusal that lands before the move: the old chat keeps the host's own words, never these", async () => {
    commitStructuredAgentSessionOutbox('old', [
      entry('m1', 'typed as the clear ran', {
        state: 'rejected',
        lastAttemptAt: 2,
        lastFailure: REFUSED_AS_CLEARED
      })
    ])
    // The old chat, still on screen, shows the refused message as a stale chat always has.
    const old = pane('old')
    expect(old.result.current.outbox).toHaveLength(1)
    expect(old.result.current.error).not.toBe(CLEARED)
    expect(readNativeChatDraftCache(scope('old'))).toBe('')
    old.unmount()
    const replacement = pane('new', { replaces: 'old' })
    await waitFor(() =>
      expect(readNativeChatDraftCache(scope('new'))).toBe('typed as the clear ran')
    )
    expect(replacement.result.current.error).toBe(CLEARED)
  })
})
