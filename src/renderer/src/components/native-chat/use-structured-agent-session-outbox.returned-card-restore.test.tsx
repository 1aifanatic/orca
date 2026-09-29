// @vitest-environment happy-dom

// A queued send the host withdrew and also publishes as a returned card has one home for its
// text, the card. When both arrive in one frame (a reload catching up), the composer gets none.

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'

const TARGET = { kind: 'local' } as const

function withdrawn(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_CANCELLED,
    submittedAt: 10,
    resolvedAt: 11,
    handoverRecorded: true
  }
}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  mocks.call.mockReset()
  mocks.call.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

describe('a withdrawn send the host returns as a card', () => {
  it('is never also restored to the composer', async () => {
    writeOutbox('session-1', [
      {
        ...createStructuredAgentSessionOutboxEntry({
          clientMessageId: 'returned',
          sessionId: 'session-1',
          text: 'follow-up',
          attachments: [],
          queuedAt: 1,
          delivery: 'queue-if-active'
        }),
        state: 'unconfirmed'
      }
    ])
    type Props = { submissions: AgentJournalSubmission[]; queuedMessageIds: string[] }
    const initialProps: Props = { submissions: [], queuedMessageIds: [] }
    const view = renderHook(
      (props: Props) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: TARGET,
          fence: 1,
          submissions: props.submissions,
          composerScopeKey: 'scope',
          queueDelivery: true,
          queuedMessageIds: props.queuedMessageIds
        }),
      { initialProps }
    )
    view.rerender({ submissions: [withdrawn('returned')], queuedMessageIds: ['returned'] })
    await waitFor(() => expect(view.result.current.outbox).toHaveLength(0))
    expect(readNativeChatDraftCache('scope')).toBe('')
  })
})
