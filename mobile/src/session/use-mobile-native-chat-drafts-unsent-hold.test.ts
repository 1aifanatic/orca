// An ack-lost send is settled by its own row, even one the host already shows as not sent, and never
// by a not-sent row of the same text that was on screen when it went out.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

function user(id: string, text: string, unsent = false): NativeChatMessage {
  return {
    id,
    role: 'user',
    source: 'transcript',
    timestamp: null,
    blocks: [{ type: 'text', text }],
    ...(unsent ? { unsent: true as const } : {})
  }
}

const ANSWER: NativeChatMessage = {
  id: 'answer',
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  blocks: [{ type: 'text', text: 'Hi' }]
}

describe('useMobileNativeChatDrafts unconfirmed hold beside not-sent rows', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatDrafts> | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
    vi.useRealTimers()
  })

  function Harness({ messages }: { messages: NativeChatMessage[] }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId: 'session-a',
      messages,
      launchDraft: null,
      transcriptLoading: false,
      transcriptSettled: true,
      queuedCards: []
    })
    return null
  }

  async function render(messages: NativeChatMessage[]): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Harness, { messages }))
      } else {
        renderer = create(createElement(Harness, { messages }))
      }
    })
  }

  /** Holds a lost send; the returned call runs out its deadline and hands back the warning spy. */
  function holdLostSend(text: string): () => ReturnType<typeof vi.fn> {
    const onUnconfirmed = vi.fn()
    const origin = state?.captureSendOrigin(text)
    if (!origin) {
      throw new Error('no send origin')
    }
    act(() => state?.holdUnconfirmedSend(origin, text, onUnconfirmed))
    return () => {
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      return onUnconfirmed
    }
  }

  const BEFORE = [user('m1', 'fix the test', true), ANSWER]

  it('stays quiet when its own row arrives already shown as not sent', async () => {
    await render(BEFORE)
    const settle = holdLostSend('fix the test')
    await render([...BEFORE, user('m2', 'fix the test', true)])
    expect(settle()).not.toHaveBeenCalled()
  })

  // Once the resend is recorded, the projection drops the not-sent original it copies.
  it('stays quiet when its resend replaces the not-sent original it was sent after', async () => {
    const before = [ANSWER, user('m1', 'fix the test', true)]
    await render(before)
    const settle = holdLostSend('fix the test')
    await render([ANSWER, user('m2', 'fix the test')])
    expect(settle()).not.toHaveBeenCalled()
  })

  it('still warns when only the older not-sent copy of its text is there', async () => {
    const before = [ANSWER, user('m1', 'fix the test', true)]
    await render(before)
    const settle = holdLostSend('fix the test')
    await render([...before])
    expect(settle()).toHaveBeenCalledTimes(1)
  })
})
