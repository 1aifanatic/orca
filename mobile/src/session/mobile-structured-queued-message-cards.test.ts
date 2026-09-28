import { describe, expect, it } from 'vitest'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED
} from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../src/shared/agent-session-wire'
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

  it('labels a reasonless pause — a Stop or restart hold — as plain Paused', () => {
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a', paused: true })], {
      pendingPrompt: false
    })
    expect(card?.label).toBe('Paused')
    expect(card?.paused).toBe(true)
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

  it('maps the send-failed pause marker to English and an unknown marker to a plain pause', () => {
    const cards = mobileQueuedMessageCards(
      [
        draft({ messageId: 'a', paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }),
        // SAFETY: a newer host's marker this build has no vocabulary for.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a marker from a newer host than this build's union.
        draft({ messageId: 'b', position: 2, paused: true, pausedReason: 'later_marker' as never })
      ],
      { pendingPrompt: false }
    )
    expect(cards.map((card) => card.label)).toEqual(["Couldn't send — Send to retry", 'Paused'])
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
