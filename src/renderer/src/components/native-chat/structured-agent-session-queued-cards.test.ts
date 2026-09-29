// Card projection policy: queue order, derived hold labels (the wire carries
// none), and the presentation-only suppression of a card whose submission
// already arrived — a queued draft is otherwise never a transcript bubble.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  newestSteerableQueuedMessageCard,
  outboxOutsideQueuedCards,
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
  dispatchState: AgentJournalSubmission['dispatchState'] = 'pending'
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
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

  it('shows a draft a Stop put back beside its rejected first submission', () => {
    // The Stop withdrew the consumed draft and requeued it under the same id; the journal keeps
    // the first submission as rejected, and the transcript hides that one too.
    const requeued = draft('requeued', 1, { paused: true, pausedReason: 'stopped' })
    expect(
      projectQueuedMessageCards([requeued], [submission('requeued', 'rejected')], IDLE)
    ).toMatchObject([{ messageId: 'requeued', state: 'waiting', hold: 'paused' }])
    for (const dispatchState of ['pending', 'accepted'] as const) {
      expect(
        projectQueuedMessageCards([requeued], [submission('requeued', dispatchState)], IDLE)
      ).toEqual([])
    }
  })

  it('suppresses a waiting card whose submission already arrived, but never a returned one', () => {
    const cards = projectQueuedMessageCards(
      [
        draft('consumed', 1),
        draft('kept', 2),
        draft('refused', 3, { state: 'returned', returnedReason: null })
      ],
      [submission('consumed'), submission('refused')],
      IDLE
    )
    expect(cards.map((card) => card.messageId)).toEqual(['kept', 'refused'])
  })

  it('steers the newest card', () => {
    const cards = projectQueuedMessageCards([draft('a', 1), draft('b', 2)], [], IDLE)
    expect(newestSteerableQueuedMessageCard(cards)?.messageId).toBe('b')
    expect(newestSteerableQueuedMessageCard([])).toBeNull()
  })

  it('a mid-turn queue send on its way is no bubble; one that stalled stays visible', () => {
    const entry = (
      clientMessageId: string,
      overrides: Partial<StructuredAgentSessionOutboxEntry> = {}
    ): StructuredAgentSessionOutboxEntry => ({
      clientMessageId,
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
      previewUris: [],
      state: 'queued',
      queuedAt: 1,
      lastAttemptAt: null,
      retryAfterUnknownSubmittedAt: null,
      delivery: 'queue-if-active',
      ...overrides
    })
    const ids = (entries: readonly StructuredAgentSessionOutboxEntry[]): string[] =>
      entries.map((candidate) => candidate.clientMessageId)
    const inFlight = [entry('a', { state: 'dispatching' }), entry('b')]
    expect(ids(outboxOutsideQueuedCards(inFlight, [], true, null))).toEqual([])
    expect(ids(outboxOutsideQueuedCards(inFlight, [], false, null))).toEqual(['a', 'b'])
    // Refused and held for Retry: its text, and everything waiting behind it, stays in view.
    const refused = [entry('a', { lastFailure: { kind: 'failed' } }), entry('b')]
    expect(ids(outboxOutsideQueuedCards(refused, [], true, 'a'))).toEqual(['a', 'b'])
    // A rejected send holds nothing up: what follows it is still on its way to a card.
    const rejected = [
      entry('a', { state: 'rejected', lastFailure: { kind: 'rejected', reason: null } }),
      entry('b')
    ]
    expect(ids(outboxOutsideQueuedCards(rejected, [], true, null))).toEqual(['a'])
    const unconfirmed = [entry('a', { state: 'unconfirmed' }), entry('b')]
    expect(ids(outboxOutsideQueuedCards(unconfirmed, [], true, null))).toEqual(['a', 'b'])
    // Once the host visibly holds it, it is a card whatever this queue last heard.
    expect(ids(outboxOutsideQueuedCards(unconfirmed, ['a'], true, null))).toEqual(['b'])
  })
})
