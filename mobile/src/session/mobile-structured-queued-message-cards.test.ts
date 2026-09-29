import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  QUEUED_MESSAGE_PAUSED_STOPPED
} from '../../../src/shared/agent-session-wire'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import { mobileQueuedMessageCards } from './mobile-structured-queued-message-cards'

/** A returned card as the host publishes it: the refusal's sentence and its typed fact. */
function returnedAs(fact: Parameters<typeof agentSessionFailureWords>[0]) {
  const { reason, rejection } = agentSessionFailureWords(fact, { surface: 'rejection' })
  return { state: 'returned' as const, returnedReason: reason, returnedRejection: rejection }
}

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

  it('labels a stopped pause — a Stop, /clear carry or restart hold — with the resume promise', () => {
    const [card] = mobileQueuedMessageCards(
      [draft({ messageId: 'a', paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_STOPPED })],
      { pendingPrompt: false }
    )
    expect(card?.label).toBe('Paused — sends after your next message')
    expect(card?.paused).toBe(true)
  })

  it('labels a reasonless pause as a plain pause, promising no release rule', () => {
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a', paused: true })], {
      pendingPrompt: false
    })
    expect(card?.label).toBe('Paused')
  })

  it("shows a returned card with the provider's own words and holds drafts behind it", () => {
    const refused = agentSessionFailureFact('providerRejected', {
      detail: { text: 'Steering is unavailable', audience: 'person' }
    })
    const cards = mobileQueuedMessageCards(
      [draft({ messageId: 'a', ...returnedAs(refused) }), draft({ messageId: 'b', position: 2 })],
      { pendingPrompt: false }
    )
    expect(cards[0]?.label).toContain('Steering is unavailable')
    expect(cards[0]?.state).toBe('returned')
    expect(cards[1]?.label).toBe('Waiting — a message ahead needs attention')
  })

  it('maps a Stop-withdrawn returned card to its own English copy', () => {
    const [card] = mobileQueuedMessageCards(
      [draft({ messageId: 'a', ...returnedAs(agentSessionFailureFact('cancelled')) })],
      { pendingPrompt: false }
    )
    expect(card?.label).toBe('Stopped before it was sent')
  })

  it('reads a Stop withdrawal from the fact, whatever sentence rides beside it', () => {
    const [card] = mobileQueuedMessageCards(
      [
        draft({
          messageId: 'a',
          state: 'returned',
          returnedReason: 'This message was withdrawn before the agent started it.',
          returnedRejection: { kind: 'cancelled' }
        })
      ],
      { pendingPrompt: false }
    )
    expect(card?.label).toBe('Stopped before it was sent')
  })

  it('words a host-restart returned card from its fact, as a rejected send', () => {
    const [card] = mobileQueuedMessageCards(
      [draft({ messageId: 'a', ...returnedAs(agentSessionFailureFact('hostRestarted')) })],
      { pendingPrompt: false }
    )
    expect(card?.label).toBe('Orca restarted before this message was sent.')
  })

  it("keeps a provider's log-only detail off the card", () => {
    const refused = agentSessionFailureFact('providerRejected', {
      detail: { text: 'stack trace for the log', audience: 'log' }
    })
    const [card] = mobileQueuedMessageCards([draft({ messageId: 'a', ...returnedAs(refused) })], {
      pendingPrompt: false
    })
    expect(card?.label).not.toContain('stack trace')
  })

  it('reads a fact kind this build cannot place as not sent, not as its sentence', () => {
    const [card] = mobileQueuedMessageCards(
      [
        draft({
          messageId: 'a',
          state: 'returned',
          returnedReason: 'Words for a kind a newer host added.',
          returnedRejection: { kind: 'laterKind' }
        })
      ],
      { pendingPrompt: false }
    )
    expect(card?.label).toBe('Your message was not sent.')
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

  it('never shows an internal rejection reason verbatim, even from a host that wrote no fact', () => {
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
    expect(card?.label).toBe('Your message was not sent.')
  })
})
