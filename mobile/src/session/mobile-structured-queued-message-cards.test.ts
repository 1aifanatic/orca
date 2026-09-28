import { describe, expect, it } from 'vitest'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED
} from '../../../src/shared/structured-agent-session-dispatch-rejection'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import { mobileQueuedMessageCards } from './mobile-structured-queued-message-cards'

function draft(overrides: Partial<AgentSessionQueuedMessage> & { messageId: string }) {
  return {
    position: 1,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `body of ${overrides.messageId}` }]
    },
    state: 'waiting' as const,
    ...overrides
  }
}

describe('mobileQueuedMessageCards', () => {
  it('renders nothing without a published list', () => {
    expect(mobileQueuedMessageCards(null, { pendingPrompt: false })).toEqual([])
    expect(mobileQueuedMessageCards([], { pendingPrompt: false })).toEqual([])
  })

  it('labels a plain waiting draft with the queue promise', () => {
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a' })], {
      pendingPrompt: false
    })
    expect(card).toEqual({
      messageId: 'a',
      text: 'body of a',
      state: 'waiting',
      paused: false,
      label: 'Queued — sends when the current turn ends'
    })
  })

  it('labels a waiting draft behind a pending prompt', () => {
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a' })], {
      pendingPrompt: true
    })
    expect(card?.label).toBe('Waiting for your answer')
  })

  it('labels a paused draft, preferring the surfaced failure copy', () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'a', paused: true }),
        draft({ messageId: 'b', position: 2, paused: true, pausedReason: 'Couldn’t send' })
      ],
      { pendingPrompt: false }
    )
    expect(cards.map((card) => card.label)).toEqual(['Paused', 'Couldn’t send'])
  })

  it('shows a returned card with its provider reason and holds drafts behind it', () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'a', state: 'returned', returnedReason: 'Steering is unavailable' }),
        draft({ messageId: 'b', position: 2 })
      ],
      { pendingPrompt: false }
    )
    expect(cards[0]?.label).toBe('Steering is unavailable')
    expect(cards[0]?.state).toBe('returned')
    expect(cards[1]?.label).toBe('Waiting — a message ahead needs attention')
  })

  it('maps a Stop-withdrawn returned card to its own English copy', () => {
    const [card] = mobileQueuedMessageCards(
      [draft({ messageId: 'a', state: 'returned', returnedReason: DISPATCH_REJECTED_CANCELLED })],
      { pendingPrompt: false }
    )
    expect(card?.label).toBe('Held back by Stop — Send to retry')
  })

  it('maps a paused marker to English and shows readable pause copy verbatim', () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'a', paused: true, pausedReason: DISPATCH_REJECTED_HOST_RESTARTED }),
        draft({ messageId: 'b', position: 2, paused: true, pausedReason: 'Couldn’t send' })
      ],
      { pendingPrompt: false }
    )
    expect(cards.map((card) => card.label)).toEqual([
      "Couldn't send — Send to retry",
      'Couldn’t send'
    ])
  })

  it('never shows an internal rejection reason verbatim', () => {
    const [card] = mobileQueuedMessageCards(
      [
        draft({
          messageId: 'a',
          state: 'returned',
          returnedReason: DISPATCH_REJECTED_HOST_RESTARTED
        })
      ],
      { pendingPrompt: false }
    )
    expect(card?.label).toBe("Couldn't send — Send to retry")
  })
})
