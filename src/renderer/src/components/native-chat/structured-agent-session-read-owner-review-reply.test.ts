// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(
  (): {
    applyEvent?: (event: AgentSessionSubscribeEvent) => void
    started: number
    disposed: number
  } => ({ started: 0, disposed: 0 })
)

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn()
}))
vi.mock('./structured-agent-session-read-transport', () => ({
  startStructuredAgentSessionReadTransport: (args: {
    applyEvent: (event: AgentSessionSubscribeEvent) => void
  }) => {
    mocks.started += 1
    mocks.applyEvent = args.applyEvent
    return {
      captureHistoryReadGuard: () => () => false,
      dispose: () => {
        mocks.disposed += 1
      }
    }
  }
}))

import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import { agentSessionReviewReplyReceiptMessageId } from '../../../../shared/agent-session-review-reply'
import { watchStructuredReviewReplySettled } from '@/lib/structured-agent-session-review-reply-settled'
import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner'

afterEach(() => {
  resetStructuredAgentSessionReadOwnersForTests()
})

function receipt(): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'session-1',
    batch: {
      cursor: { epoch: 'e', sequence: 3 },
      items: [],
      removedItemIds: [
        agentJournalItemKey({
          provider: 'orca',
          clientMessageId: agentSessionReviewReplyReceiptMessageId('message-1')
        })
      ],
      submissions: []
    }
  }
}

it("hears a hidden chat's review-reply receipt: the armed watch keeps the chat's read open", () => {
  const settled = vi.fn()
  // No pane shows the chat: only the watch activates its read.
  watchStructuredReviewReplySettled('session-1', settled, {
    holdRead: () => getStructuredAgentSessionReadOwner('session-1', { kind: 'local' }).activate()
  })
  expect(mocks.started).toBe(1)

  mocks.applyEvent?.(receipt())

  expect(settled).toHaveBeenCalledOnce()
  // Fired, so the read it held is let go.
  expect(mocks.disposed).toBe(1)
})
