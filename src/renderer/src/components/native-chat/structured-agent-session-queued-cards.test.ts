// Card projection policy: queue order, derived hold labels (the wire carries
// none), and the presentation-only suppression of a card whose submission
// already arrived — a queued draft is otherwise never a transcript bubble.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import {
  newestSteerableQueuedMessageCard,
  pendingSendsOutsideQueuedCards,
  projectQueuedMessageCards
} from './structured-agent-session-queued-cards'

function draft(
  id: string,
  position: number,
  overrides: Partial<AgentSessionQueuedMessage> = {}
): AgentSessionQueuedMessage {
  return {
    messageId: id,
    position,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `text of ${id}` }] },
    state: 'waiting',
    ...overrides
  }
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'] = 'pending',
  queuedMessageId?: string
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...(queuedMessageId !== undefined ? { queuedMessageId } : {})
  }
}

/** The host's hand-off of draft `draftId`, always under a submission id of its own. */
function handOff(
  draftId: string,
  dispatchState: AgentJournalSubmission['dispatchState'] = 'pending',
  id = `${draftId}-hand-off`
): AgentJournalSubmission {
  return submission(id, dispatchState, draftId)
}

const IDLE = { hasPendingPrompt: false }

describe('queued message cards', () => {
  it('orders by host position whatever order the list arrives in', () => {
    const cards = projectQueuedMessageCards([draft('b', 2), draft('a', 1), draft('c', 3)], [], IDLE)
    expect(cards.map((card) => card.messageId)).toEqual(['a', 'b', 'c'])
    expect(cards[0]?.text).toBe('text of a')
  })

  it('holds: waiting defaults to the turn, a pending prompt changes the caption', () => {
    expect(projectQueuedMessageCards([draft('a', 1)], [], IDLE)[0]?.hold).toBe('turn')
    expect(
      projectQueuedMessageCards([draft('a', 1)], [], { hasPendingPrompt: true })[0]?.hold
    ).toBe('awaiting-answer')
  })

  it('a returned card carries its stored reason and blocks the label of drafts behind it', () => {
    const cards = projectQueuedMessageCards(
      [
        draft('failed', 1, {
          state: 'returned',
          returnedReason: 'agent_session_write_failed',
          returnedRejection: { kind: 'writeFailed' }
        }),
        draft('behind', 2)
      ],
      [],
      IDLE
    )
    expect(cards[0]).toMatchObject({
      state: 'returned',
      hold: 'returned',
      returnedReason: 'agent_session_write_failed',
      returnedRejection: { kind: 'writeFailed' }
    })
    expect(cards[1]?.hold).toBe('behind-returned')
  })

  it('a paused draft says so, carrying the host marker for the caption to localize', () => {
    const cards = projectQueuedMessageCards(
      [draft('a', 1, { paused: true, pausedReason: 'send_failed' })],
      [],
      IDLE
    )
    expect(cards[0]).toMatchObject({ hold: 'paused', pausedReason: 'send_failed' })
  })

  it('shows a draft a Stop put back: its rejected hand-off is what sent it back', () => {
    // The Stop pause belongs to the queue, so the draft itself carries no hold.
    const requeued = draft('requeued', 1)
    expect(
      projectQueuedMessageCards([requeued], [handOff('requeued', 'rejected')], IDLE)
    ).toMatchObject([{ messageId: 'requeued', state: 'waiting' }])
    for (const dispatchState of ['pending', 'accepted'] as const) {
      expect(
        projectQueuedMessageCards([requeued], [handOff('requeued', dispatchState)], IDLE)
      ).toEqual([])
    }
  })

  it('requeued and drained again under a fresh id, the card and the bubble never show together', () => {
    // A multi-page catch-up: the new hand-off's bubble arrives before the list that drops the card.
    const cards = projectQueuedMessageCards(
      [draft('requeued', 1)],
      [handOff('requeued', 'rejected', 'first'), handOff('requeued', 'pending', 'second')],
      IDLE
    )
    expect(cards).toEqual([])
  })

  it('hides a waiting card only by the link, never by a submission id that equals the draft id', () => {
    const cards = projectQueuedMessageCards(
      [
        draft('consumed', 1),
        draft('kept', 2),
        draft('refused', 3, { state: 'returned', returnedReason: null })
      ],
      [handOff('consumed'), submission('kept'), handOff('refused', 'rejected')],
      IDLE
    )
    expect(cards.map((card) => card.messageId)).toEqual(['kept', 'refused'])
  })

  it('a paused queue outranks a pending prompt: an answer does not drain it', () => {
    const cards = projectQueuedMessageCards(
      [
        draft('waiting', 1),
        draft('failed', 2, { paused: true, pausedReason: 'send_failed' }),
        draft('refused', 3, { state: 'returned', returnedReason: null }),
        draft('behind', 4)
      ],
      [],
      { hasPendingPrompt: true, queuePaused: true }
    )
    expect(cards.map((card) => card.hold)).toEqual([
      'queue-paused',
      'paused',
      'returned',
      'behind-returned'
    ])
    expect(
      projectQueuedMessageCards([draft('waiting', 1)], [], { hasPendingPrompt: true })[0]?.hold
    ).toBe('awaiting-answer')
  })

  it('steers the newest card', () => {
    const cards = projectQueuedMessageCards([draft('a', 1), draft('b', 2)], [], IDLE)
    expect(newestSteerableQueuedMessageCard(cards)?.messageId).toBe('b')
    expect(newestSteerableQueuedMessageCard([])).toBeNull()
  })

  it('a mid-turn queue send on its way is no bubble; plain, unconfirmed and recorded ones differ', () => {
    const entry = (
      clientMessageId: string,
      overrides: Partial<StructuredAgentSessionPendingSend> = {}
    ): StructuredAgentSessionPendingSend => ({
      clientMessageId,
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
      previewUris: [],
      queuedAt: 1,
      phase: 'sending',
      issued: true,
      ...overrides
    })
    const ids = (entries: readonly StructuredAgentSessionPendingSend[]): string[] =>
      entries.map((candidate) => candidate.clientMessageId)
    const sends = [
      entry('queued', { delivery: 'queue-if-active' }),
      entry('waiting', { delivery: 'queue-if-active', phase: 'waiting', issued: false }),
      entry('plain'),
      entry('in-doubt', { delivery: 'queue-if-active', phase: 'in-doubt' }),
      entry('recorded', { phase: 'recorded' })
    ]
    // Its card draws a queue send while the agent works; a plain send and an unconfirmed one
    // stay in view; the host's row draws a recorded one.
    expect(ids(pendingSendsOutsideQueuedCards(sends, [], true))).toEqual(['plain', 'in-doubt'])
    expect(ids(pendingSendsOutsideQueuedCards(sends, [], false))).toEqual([
      'queued',
      'waiting',
      'plain',
      'in-doubt'
    ])
    // Once the host visibly holds it, it is a card.
    expect(ids(pendingSendsOutsideQueuedCards(sends, ['plain', 'in-doubt'], false))).toEqual([
      'queued',
      'waiting'
    ])
  })
})
