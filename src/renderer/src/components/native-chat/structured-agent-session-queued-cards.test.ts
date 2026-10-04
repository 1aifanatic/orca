// Card projection policy: queue order, derived hold labels (the wire carries
// holds, not labels), and the presentation-only suppression of a card whose submission
// already arrived — a queued draft is otherwise never a transcript bubble.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  newestSteerableQueuedMessageCard,
  outboxOutsideQueuedCards,
  ownDirectSendOnItsWay,
  projectQueuedMessageCards,
  queuedMessageCardSteers,
  queuedMessagesQueuePause,
  queuedMessagesResumable
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
const QUEUEING = { capability: 'supported', enabled: true } as const

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
      { hasPendingPrompt: true, queuePause: { reason: 'stopped' } }
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

  it("a host that names each card's hold holds only those cards; one that does not holds every card", () => {
    const named = [
      draft('held', 1, { heldBy: { reason: 'stopped' } }),
      draft('typed-after', 2, { heldBy: null })
    ]
    const paused = { hasPendingPrompt: true, queuePause: { reason: 'restarted' } } as const
    // The card queued after the Stop still says it waits for the answer.
    expect(projectQueuedMessageCards(named, [], paused).map((card) => card.hold)).toEqual([
      'queue-paused',
      'awaiting-answer'
    ])
    const older = [draft('held', 1), draft('typed-after', 2)]
    expect(projectQueuedMessageCards(older, [], paused).map((card) => card.hold)).toEqual([
      'queue-paused',
      'queue-paused'
    ])
  })

  it('Resume only over a card a pause holds, and only while nothing runs', () => {
    const project = (messages: AgentSessionQueuedMessage[]) =>
      projectQueuedMessageCards(messages, [], {
        hasPendingPrompt: false,
        queuePause: { reason: 'stopped' }
      })
    const held = draft('held', 1, { heldBy: { reason: 'stopped' } })
    expect(queuedMessagesResumable(project([held]), false)).toBe(true)
    // Working counts the queue's coming send, which the host names.
    expect(queuedMessagesResumable(project([held]), true)).toBe(false)
    const failed = draft('failed', 1, { paused: true, pausedReason: 'send_failed', heldBy: null })
    expect(queuedMessagesResumable(project([failed]), false)).toBe(false)
    expect(project([held, draft('next', 2, { heldBy: null })]).map((card) => card.hold)).toEqual([
      'queue-paused',
      'turn'
    ])
    const [card] = project([held])
    // Still Steer while nothing runs: the header row, not the card, says it waits.
    expect(card && queuedMessageCardSteers(card)).toBe(true)
  })

  it("the header names the oldest held card's pause, and none over cards Resume would not send", () => {
    const project = (messages: AgentSessionQueuedMessage[]) =>
      projectQueuedMessageCards(messages, [], {
        hasPendingPrompt: false,
        queuePause: { reason: 'stopped' }
      })
    const restarted = draft('restarted', 1, { heldBy: { reason: 'restarted' } })
    const stopped = draft('stopped', 2, { heldBy: { reason: 'stopped' } })
    expect(queuedMessagesQueuePause(project([restarted, stopped]))).toEqual({ reason: 'restarted' })
    // An older host names no per-card hold: its queue-level pause is the reason.
    expect(queuedMessagesQueuePause(project([draft('older', 1)]))).toEqual({ reason: 'stopped' })
    const unsendable = [
      draft('returned', 1, { state: 'returned', returnedReason: null, heldBy: null }),
      draft('behind', 2, { heldBy: { reason: 'stopped' } }),
      draft('failed', 3, {
        paused: true,
        pausedReason: 'send_failed',
        heldBy: { reason: 'stopped' }
      })
    ]
    expect(queuedMessagesQueuePause(project(unsendable))).toBeNull()
    expect(
      queuedMessagesQueuePause(project([draft('typed-after', 1, { heldBy: null })]))
    ).toBeNull()
  })

  it("only the person's own direct send, recorded and not yet accepted, is on its way to lift a pause", () => {
    const entry = (
      clientMessageId: string,
      state: StructuredAgentSessionOutboxEntry['state'] = 'dispatching'
    ): StructuredAgentSessionOutboxEntry => ({
      clientMessageId,
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
      previewUris: [],
      state,
      queuedAt: 1,
      lastAttemptAt: 1,
      retryAfterUnknownSubmittedAt: null
    })
    expect(ownDirectSendOnItsWay([entry('mine')], [submission('mine')])).toBe(true)
    // Not yet recorded: it may still become a card.
    expect(ownDirectSendOnItsWay([entry('mine')], [])).toBe(false)
    // Orca's own send never enters this outbox.
    expect(ownDirectSendOnItsWay([], [submission('orca')])).toBe(false)
    // The queue's send of a card goes under a fresh id, even for a card this composer queued.
    expect(ownDirectSendOnItsWay([entry('card')], [handOff('card')])).toBe(false)
    expect(ownDirectSendOnItsWay([entry('mine', 'rejected')], [submission('mine')])).toBe(false)
    expect(ownDirectSendOnItsWay([entry('mine')], [submission('mine', 'rejected')])).toBe(false)
    expect(ownDirectSendOnItsWay([entry('mine')], [submission('mine', 'unknown')])).toBe(false)
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
      ...overrides
    })
    const ids = (entries: readonly StructuredAgentSessionOutboxEntry[]): string[] =>
      entries.map((candidate) => candidate.clientMessageId)
    const inFlight = [
      entry('a', { state: 'dispatching', lastAttemptAt: 2, sentDelivery: 'queue-if-active' }),
      entry('b')
    ]
    expect(ids(outboxOutsideQueuedCards(inFlight, [], true, QUEUEING))).toEqual([])
    expect(ids(outboxOutsideQueuedCards(inFlight, [], false, QUEUEING))).toEqual(['a', 'b'])
    // Refused and held for Retry: its text stays in view, and what follows it is on its way.
    const refused = [entry('a', { lastFailure: { kind: 'failed' } }), entry('b')]
    expect(ids(outboxOutsideQueuedCards(refused, [], true, QUEUEING))).toEqual(['a'])
    // A rejected send holds nothing up: what follows it is still on its way to a card.
    const rejected = [
      entry('a', { state: 'rejected', lastFailure: { kind: 'rejected', reason: null } }),
      entry('b')
    ]
    expect(ids(outboxOutsideQueuedCards(rejected, [], true, QUEUEING))).toEqual(['a'])
    const unconfirmed = [entry('a', { state: 'unconfirmed' }), entry('b')]
    expect(ids(outboxOutsideQueuedCards(unconfirmed, [], true, QUEUEING))).toEqual(['a', 'b'])
    // Once the host visibly holds it, it is a card whatever this queue last heard.
    expect(ids(outboxOutsideQueuedCards(unconfirmed, ['a'], true, QUEUEING))).toEqual(['b'])
  })

  it('hides a send only by what its request carries: a plain one is always a bubble', () => {
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
      ...overrides
    })
    const ids = (entries: readonly StructuredAgentSessionOutboxEntry[]): string[] =>
      entries.map((candidate) => candidate.clientMessageId)
    // The capability is unknown: a new send goes out plain, so it stays in view.
    const unknown = { capability: 'unknown', enabled: true } as const
    expect(ids(outboxOutsideQueuedCards([entry('new')], [], true, unknown))).toEqual(['new'])
    // A send that went out plain stays a bubble; one that went out queued replays queued.
    const sent = [
      entry('plain', { state: 'dispatching', lastAttemptAt: 2, sentDelivery: null }),
      entry('queued', { state: 'dispatching', lastAttemptAt: 2, sentDelivery: 'queue-if-active' })
    ]
    expect(ids(outboxOutsideQueuedCards(sent, [], true, unknown))).toEqual(['plain'])
  })
})
