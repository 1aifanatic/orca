// The `queuedMessages` claim: live frames own it, an omitted field means
// "unchanged", history never replaces a newer live list, and absence stays
// absence (an older host makes no claim at all).

import { describe, expect, it } from 'vitest'
import type {
  AgentSessionHistoryPage,
  AgentSessionQueuedMessage,
  AgentSessionSubscribeEvent
} from './agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

function queued(id: string, position: number): AgentSessionQueuedMessage {
  return {
    messageId: id,
    position,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
    state: 'waiting'
  }
}

function page(queuedMessages?: AgentSessionQueuedMessage[] | null): AgentSessionHistoryPage {
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: null,
      newest: null,
      nextCursor: { epoch: 'epoch-a', sequence: 0 }
    },
    liveCursor: { epoch: 'epoch-a', sequence: 0 },
    hasOlder: false,
    hasNewer: false,
    ...(queuedMessages !== undefined ? { queuedMessages } : {})
  }
}

function snapshot(queuedMessages?: AgentSessionQueuedMessage[] | null): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-a',
    page: page(),
    fence: 1,
    ...(queuedMessages !== undefined ? { queuedMessages } : {})
  }
}

function batch(
  sequence: number,
  queuedMessages?: AgentSessionQueuedMessage[] | null
): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'session-a',
    batch: {
      cursor: { epoch: 'epoch-a', sequence },
      items: [],
      removedItemIds: [],
      submissions: []
    },
    ...(queuedMessages !== undefined ? { queuedMessages } : {})
  }
}

function hydrated(
  queuedMessages?: AgentSessionQueuedMessage[] | null
): StructuredAgentSessionState {
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: snapshot(queuedMessages)
  })
}

describe('structured agent session reducer: queuedMessages', () => {
  it('adopts the list from a snapshot and keeps it through a batch that omits it', () => {
    const state = hydrated([queued('draft-1', 1)])
    expect(state.queuedMessages).toEqual([queued('draft-1', 1)])
    const after = reduceStructuredAgentSession(state, { type: 'event', event: batch(1) })
    expect(after.queuedMessages).toEqual([queued('draft-1', 1)])
  })

  it('replaces the whole list from a batch that carries one, empty included', () => {
    const state = hydrated([queued('draft-1', 1)])
    const grown = reduceStructuredAgentSession(state, {
      type: 'event',
      event: batch(1, [queued('draft-1', 1), queued('draft-2', 2)])
    })
    expect(grown.queuedMessages).toHaveLength(2)
    const drained = reduceStructuredAgentSession(grown, { type: 'event', event: batch(2, []) })
    expect(drained.queuedMessages).toEqual([])
  })

  it('changes state for a list update at an unchanged cursor and journal', () => {
    const state = reduceStructuredAgentSession(hydrated([]), { type: 'event', event: batch(1) })
    const after = reduceStructuredAgentSession(state, {
      type: 'event',
      event: batch(1, [queued('draft-1', 1)])
    })
    expect(after).not.toBe(state)
    expect(after.queuedMessages).toEqual([queued('draft-1', 1)])
  })

  it('never lets a stale history answer replace a newer live list', () => {
    const state = reduceStructuredAgentSession(hydrated([]), {
      type: 'event',
      event: batch(1, [queued('draft-2', 2)])
    })
    const after = reduceStructuredAgentSession(state, {
      type: 'history-page',
      page: page([queued('draft-1', 1)])
    })
    expect(after.queuedMessages).toEqual([queued('draft-2', 2)])
  })

  it('adopts a history page claim when the live stream has made none', () => {
    const after = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: page([queued('draft-1', 1)])
    })
    expect(after.queuedMessages).toEqual([queued('draft-1', 1)])
  })

  it('makes no claim when no frame carried the field (older host)', () => {
    const state = hydrated()
    expect('queuedMessages' in state).toBe(false)
    const after = reduceStructuredAgentSession(state, { type: 'event', event: batch(1) })
    expect('queuedMessages' in after).toBe(false)
  })

  it('a reset re-hydrates the list from its own frame', () => {
    const state = hydrated([queued('draft-1', 1)])
    const after = reduceStructuredAgentSession(state, {
      type: 'event',
      event: {
        type: 'reset',
        sessionId: 'session-a',
        reset: 'epoch_changed',
        page: page(),
        fence: 2,
        queuedMessages: []
      }
    })
    expect(after.queuedMessages).toEqual([])
  })
})
