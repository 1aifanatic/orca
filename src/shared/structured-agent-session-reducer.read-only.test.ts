import { expect, it } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionSubscribeEvent } from './agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

const CURSOR = { epoch: 'epoch-a', sequence: 2 }

function page(readOnly?: 'written-by-newer-orca'): AgentSessionHistoryPage {
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: CURSOR },
    liveCursor: CURSOR,
    hasOlder: false,
    hasNewer: false,
    ...(readOnly ? { readOnly } : {})
  }
}

function apply(state: StructuredAgentSessionState, event: AgentSessionSubscribeEvent) {
  return reduceStructuredAgentSession(state, { type: 'event', event }, 1)
}

it("keeps the host's read-only reason from a whole page until a later whole page drops it", () => {
  const snapshot = apply(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'snapshot',
    sessionId: 'session-a',
    page: page('written-by-newer-orca'),
    fence: 1
  })
  expect(snapshot.readOnly).toBe('written-by-newer-orca')

  const batch = apply(snapshot, {
    type: 'batch',
    sessionId: 'session-a',
    batch: {
      cursor: { epoch: 'epoch-a', sequence: 3 },
      items: [],
      removedItemIds: [],
      submissions: []
    }
  })
  expect(batch.readOnly).toBe('written-by-newer-orca')

  const reset = apply(batch, {
    type: 'reset',
    sessionId: 'session-a',
    reset: 'schema_unreadable',
    page: page('written-by-newer-orca'),
    fence: 1
  })
  expect(reset.readOnly).toBe('written-by-newer-orca')

  // An updated host restarts and hydrates the client again, writable.
  const writable = apply(reset, {
    type: 'snapshot',
    sessionId: 'session-a',
    page: page(),
    fence: 2
  })
  expect(writable).not.toHaveProperty('readOnly')
  const history = reduceStructuredAgentSession(writable, {
    type: 'history-page',
    page: page('written-by-newer-orca')
  })
  expect(history.readOnly).toBe('written-by-newer-orca')
})
