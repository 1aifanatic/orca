import { describe, expect, it } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { reduceMobileQueuedMessageFeed } from './mobile-structured-queued-message-feed'

function draft(messageId: string, position: number): AgentSessionQueuedMessage {
  return {
    messageId,
    position,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `text ${messageId}` }] },
    state: 'waiting'
  }
}

function batch(queuedMessages?: AgentSessionQueuedMessage[] | null): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'session-1',
    batch: { cursor: { epoch: 'e', sequence: 1 }, items: [], removedItemIds: [], submissions: [] },
    ...(queuedMessages !== undefined ? { queuedMessages } : {})
  }
}

describe('reduceMobileQueuedMessageFeed', () => {
  it('holds no claim until the host publishes the field', () => {
    expect(reduceMobileQueuedMessageFeed(null, batch())).toBeNull()
  })

  it('adopts a published list ordered by position', () => {
    const next = reduceMobileQueuedMessageFeed(null, batch([draft('b', 2), draft('a', 1)]))
    expect(next?.map((entry) => entry.messageId)).toEqual(['a', 'b'])
  })

  it('keeps the last list when a frame omits the field', () => {
    const held = reduceMobileQueuedMessageFeed(null, batch([draft('a', 1)]))
    expect(reduceMobileQueuedMessageFeed(held, batch())).toBe(held)
  })

  it('reads null as empty', () => {
    const held = reduceMobileQueuedMessageFeed(null, batch([draft('a', 1)]))
    expect(reduceMobileQueuedMessageFeed(held, batch(null))).toEqual([])
  })

  it('never advances on the end frame', () => {
    const held = reduceMobileQueuedMessageFeed(null, batch([draft('a', 1)]))
    expect(reduceMobileQueuedMessageFeed(held, { type: 'end' })).toBe(held)
  })
})
