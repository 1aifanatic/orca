// A crash right after Enter can keep the sent text on disk: the clear was written, but the
// browser had not committed it. The host's history decides on relaunch whether it was sent.

// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import type * as NativeChatDraftCache from './native-chat-draft-cache'
import type * as SentHistoryHook from './use-native-chat-draft-sent-history'

const CHAT = 'session:s1'
const KEY = `orca:nativeChatComposerDraft:v1:${encodeURIComponent(CHAT)}`

type Modules = { cache: typeof NativeChatDraftCache; hook: typeof SentHistoryHook }

/** A fresh renderer: module memory is gone, only localStorage remains. */
async function relaunch(): Promise<Modules> {
  cleanup()
  vi.resetModules()
  return {
    cache: await import('./native-chat-draft-cache'),
    hook: await import('./use-native-chat-draft-sent-history')
  }
}

function sent(sequence: number, text: string, images: string[] = []): AgentJournalRenderItem {
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: 0,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text },
        ...images.map((path) => ({ type: 'image-ref' as const, path }))
      ]
    }
  }
}

function history(sequence: number, items: AgentJournalRenderItem[]): StructuredAgentSessionState {
  return {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    status: 'ready',
    epoch: 'e1',
    cursor: { epoch: 'e1', sequence },
    items
  }
}

/** Types a draft with the chat's history read up to `seen`, as a view does, and saves it. */
async function saveDraft(
  seen: StructuredAgentSessionState,
  text: string,
  attachments: { id: string; path: string }[] = []
): Promise<void> {
  const { cache, hook } = await relaunch()
  renderHook(() => hook.useNativeChatDraftSentHistory(CHAT, seen, true))
  cache.appendNativeChatDraftNow(CHAT, { text, attachments })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('a saved structured draft on relaunch', () => {
  // (a) The send landed after the draft was saved; only its clear was lost.
  it('is dropped, on disk too, when the host accepted its text after it was saved', async () => {
    await saveDraft(history(10, [sent(9, 'earlier')]), 'ship it')

    const { cache, hook } = await relaunch()
    renderHook(() =>
      hook.useNativeChatDraftSentHistory(
        CHAT,
        history(12, [sent(9, 'earlier'), sent(11, 'ship it')]),
        true
      )
    )

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('')
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  // (b) The same text, typed again on purpose after it was sent.
  it('is kept when the matching send is the one it was saved after', async () => {
    await saveDraft(history(11, [sent(11, 'ship it')]), 'ship it')

    const { cache, hook } = await relaunch()
    renderHook(() =>
      hook.useNativeChatDraftSentHistory(CHAT, history(11, [sent(11, 'ship it')]), true)
    )

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('ship it')
  })

  // (c) Never shown and then pulled away.
  it('waits for the history, then decides', async () => {
    await saveDraft(history(10, []), 'ship it')

    const { cache, hook } = await relaunch()
    const view = renderHook(({ state }) => hook.useNativeChatDraftSentHistory(CHAT, state, true), {
      initialProps: { state: { ...EMPTY_STRUCTURED_AGENT_SESSION, status: 'loading' as const } }
    })
    expect(cache.readNativeChatDraftCache(CHAT)).toBe('')
    view.rerender({ state: history(12, [sent(11, 'ship it')]) })

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('')
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  // (d) Losing contact is not proof the message was sent.
  it('is restored when the history cannot be read', async () => {
    await saveDraft(history(10, []), 'ship it')

    const { cache, hook } = await relaunch()
    renderHook(() =>
      hook.useNativeChatDraftSentHistory(
        CHAT,
        { ...EMPTY_STRUCTURED_AGENT_SESSION, status: 'error', error: 'offline' },
        true
      )
    )

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('ship it')
  })

  // (e)
  it('is kept when the host accepted different text', async () => {
    await saveDraft(history(10, []), 'ship it')

    const { cache, hook } = await relaunch()
    renderHook(() =>
      hook.useNativeChatDraftSentHistory(CHAT, history(12, [sent(11, 'hold it')]), true)
    )

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('ship it')
  })

  // (f) Text and images both have to match: an image the send did not carry was not sent.
  it.each([
    ['dropped when the send carried the same images', ['/a.png'], ''],
    ['kept when the send carried other images', ['/b.png'], 'look']
  ])('is %s', async (_case, sentImages, expected) => {
    await saveDraft(history(10, []), 'look', [{ id: 'i1', path: '/a.png' }])

    const { cache, hook } = await relaunch()
    renderHook(() =>
      hook.useNativeChatDraftSentHistory(CHAT, history(12, [sent(11, 'look', sentImages)]), true)
    )

    expect(cache.readNativeChatDraftCache(CHAT)).toBe(expected)
  })

  it('is kept when the history is from another epoch, which cannot be ordered against it', async () => {
    await saveDraft(history(10, []), 'ship it')

    const { cache, hook } = await relaunch()
    renderHook(() =>
      hook.useNativeChatDraftSentHistory(
        CHAT,
        {
          ...history(12, [sent(11, 'ship it')]),
          epoch: 'e2',
          cursor: { epoch: 'e2', sequence: 12 }
        },
        true
      )
    )

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('ship it')
  })
})
