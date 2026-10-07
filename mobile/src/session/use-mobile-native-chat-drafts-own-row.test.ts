// A structured send's bubble and its unconfirmed hold are settled by the row the host records under
// the send's own id, delivered or not sent, and never by another row with the same text.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type QueuedCard = { messageId: string; text: string }

function user(clientMessageId: string, text: string, unsent = false): NativeChatMessage {
  return {
    id: agentJournalSubmissionKey(clientMessageId),
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

describe('useMobileNativeChatDrafts with a structured send id', () => {
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

  function Harness(props: { messages: NativeChatMessage[]; queuedCards: QueuedCard[] }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId: 'session-a',
      messages: props.messages,
      launchDraft: null,
      transcriptLoading: false,
      transcriptSettled: true,
      queuedCards: props.queuedCards
    })
    return null
  }

  async function render(messages: NativeChatMessage[], queuedCards: QueuedCard[] = []) {
    await act(async () => {
      const element = createElement(Harness, { messages, queuedCards })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  function origin(text: string) {
    const captured = state?.captureSendOrigin(text)
    if (!captured) {
      throw new Error('no send origin')
    }
    return captured
  }

  /** Holds a lost send; the returned call runs out its deadline and hands back the warning spy. */
  function holdLostSend(text: string, clientMessageId: string): () => ReturnType<typeof vi.fn> {
    const onUnconfirmed = vi.fn()
    const captured = origin(text)
    act(() => state?.holdUnconfirmedSend(captured, text, onUnconfirmed, clientMessageId))
    return () => {
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      return onUnconfirmed
    }
  }

  const BEFORE = [ANSWER, user('m1', 'fix the test', true)]

  it('retires the bubble on its own row, even once the not-sent original is gone', async () => {
    await render(BEFORE)
    const captured = origin('fix the test')
    act(() => state?.acceptSend(captured, 'fix the test', undefined, 'm2'))
    expect(state?.pending.map((item) => item.text)).toEqual(['fix the test'])
    // Once the resend is recorded the projection drops the not-sent original it copies.
    await render([ANSWER, user('m2', 'fix the test')])
    expect(state?.pending).toEqual([])
  })

  it('stays quiet when its own row arrives already shown as not sent', async () => {
    await render(BEFORE)
    const settle = holdLostSend('later', 'm2')
    await render([...BEFORE, user('m2', 'later', true)])
    expect(settle()).not.toHaveBeenCalled()
  })

  it('still warns when only another row with its text is there', async () => {
    await render(BEFORE)
    const settle = holdLostSend('fix the test', 'm2')
    await render([...BEFORE, user('m3', 'fix the test')])
    expect(settle()).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the host holds it as its own card, not one with the same text', async () => {
    await render(BEFORE, [{ messageId: 'other', text: 'queued words' }])
    const settle = holdLostSend('queued words', 'm2')
    await render(BEFORE, [
      { messageId: 'other', text: 'queued words' },
      { messageId: 'm2', text: 'queued words' }
    ])
    expect(settle()).not.toHaveBeenCalled()
  })

  it('still warns when a new card has its text but is not its own', async () => {
    await render(BEFORE)
    const settle = holdLostSend('queued words', 'm2')
    await render(BEFORE, [{ messageId: 'another-phone', text: 'queued words' }])
    expect(settle()).toHaveBeenCalledTimes(1)
  })
})
