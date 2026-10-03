import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), watchHostContact: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSession: mocks.subscribe
}))
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: mocks.watchHostContact
}))

import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import { agentSessionReviewReplyReceiptMessageId } from '../../../../shared/agent-session-review-reply'
import { watchStructuredReviewReplySettled } from '@/lib/structured-agent-session-review-reply-settled'
import { startStructuredAgentSessionReadTransport } from './structured-agent-session-read-transport'

afterEach(() => {
  vi.useRealTimers()
})

it("tells a review reply's watcher when the chat's live stream brings its receipt", async () => {
  vi.useFakeTimers()
  let onEvent: (event: AgentSessionSubscribeEvent) => void = () => {}
  mocks.subscribe.mockImplementation((_target, _params, listener) => {
    onEvent = listener
    return new Promise(() => {})
  })
  const settled = vi.fn()
  const dispose = watchStructuredReviewReplySettled('session-a', settled)
  const transport = startStructuredAgentSessionReadTransport({
    applyEvent: () => {},
    applyError: vi.fn(),
    getCursor: () => null,
    onHistoryReadInvalidated: () => undefined,
    sessionId: 'session-a',
    target: { kind: 'local' }
  })
  await vi.advanceTimersByTimeAsync(0)

  onEvent({
    type: 'batch',
    sessionId: 'session-a',
    batch: {
      cursor: { epoch: 'epoch-a', sequence: 3 },
      items: [],
      removedItemIds: [
        agentJournalItemKey({
          provider: 'orca',
          clientMessageId: agentSessionReviewReplyReceiptMessageId('message-1')
        })
      ],
      submissions: []
    }
  })
  await vi.advanceTimersByTimeAsync(100)

  expect(settled).toHaveBeenCalledOnce()
  transport.dispose()
  dispose()
})
