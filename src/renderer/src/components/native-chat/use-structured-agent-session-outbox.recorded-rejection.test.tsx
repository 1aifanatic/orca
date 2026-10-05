// @vitest-environment happy-dom

// A send the host recorded and then rejected, whose row is on a page not loaded: submissions come
// only with their page's rows, so after a reopen nothing but the entry knows the host rejected it.
// The entry keeps the host's fact, is never sent again, draws "Not sent" in the host's words, owes
// no delivery, and leaves silently when its row loads or the host's window for it closes.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../../../shared/agent-session-host-authority'
import { DISPATCH_REJECTED_NOT_DELIVERED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionOutboxOwesDelivery } from '../../../../shared/structured-agent-session-outbox'

type SendParams = { envelope: { clientOperationId: string; payloadFingerprint: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SendParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { hasUndeliveredStructuredAgentSessionOutbox } from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

const NO_ITEMS: readonly AgentJournalRenderItem[] = []
const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []
const LOCAL = { kind: 'local' as const }
const WORDS = 'This message was not delivered. Send it again to continue.'

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

function rejected(clientMessageId: string, payloadFingerprint = 'fp'): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint,
    dispatchState: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_NOT_DELIVERED,
    rejection: { kind: 'notDelivered' },
    submittedAt: 10,
    resolvedAt: 11
  }
}

function row(clientMessageId: string): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 1,
    sequence: 3,
    observedAt: 3,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'steer this way' }] }
  }
}

type Props = {
  submissions: readonly AgentJournalSubmission[]
  journalItems: readonly AgentJournalRenderItem[]
  journalCursor: AgentJournalCursor
}

function open(initialProps: Props) {
  return renderHook(
    (props: Props) =>
      useStructuredAgentSessionOutbox({
        sessionId: 's1',
        target: LOCAL,
        fence: 1,
        submissions: props.submissions,
        journalItems: props.journalItems,
        journalCursor: props.journalCursor
      }),
    { initialProps }
  )
}

/** Sends one message whose reply says the host recorded and rejected it, then closes the chat. */
async function sendRejectedThenClose(): Promise<string> {
  mocks.call.mockImplementation(async (_target, _method, { envelope }) => ({
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'e', sequence: 10 },
    value: {
      clientMessageId: envelope.clientOperationId,
      submission: rejected(envelope.clientOperationId, envelope.payloadFingerprint)
    }
  }))
  const first = open({
    submissions: NO_SUBMISSIONS,
    journalItems: NO_ITEMS,
    journalCursor: { epoch: 'e', sequence: 5 }
  })
  act(() => {
    first.result.current.send('steer this way')
  })
  await waitFor(() => expect(first.result.current.outbox[0]?.recordedRejection).toBeDefined())
  const id = first.result.current.outbox[0]!.clientMessageId
  first.unmount()
  return id
}

/** Reopened on a page that holds neither its row nor its submission. */
const REOPENED: Props = {
  submissions: NO_SUBMISSIONS,
  journalItems: NO_ITEMS,
  journalCursor: { epoch: 'e', sequence: 20 }
}

it("keeps the host's fact, and after a reopen never sends it again, draws it not sent, and owes nothing", async () => {
  const id = await sendRejectedThenClose()
  const reopened = open(REOPENED)
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)))

  expect(mocks.call).toHaveBeenCalledOnce()
  const outbox = reopened.result.current.outbox
  expect(outbox).toMatchObject([
    { clientMessageId: id, recordedRejection: { reason: DISPATCH_REJECTED_NOT_DELIVERED } }
  ])
  expect(
    projectStructuredAgentSessionMessages(NO_ITEMS, outbox, NO_SUBMISSIONS, [])
      .filter((message) => message.role === 'user')
      .map(({ id: rowId, unsent }) => ({ id: rowId, unsent }))
  ).toEqual([{ id: agentJournalSubmissionKey(id), unsent: true }])
  expect(
    structuredAgentSessionDeliveryNotices(outbox, 'Claude', NO_SUBMISSIONS, []).get(
      agentJournalSubmissionKey(id)
    )
  ).toEqual({ muted: true, text: WORDS })
  expect(structuredAgentSessionOutboxOwesDelivery(outbox, NO_SUBMISSIONS)).toBe(false)
  expect(hasUndeliveredStructuredAgentSessionOutbox('s1')).toBe(false)
  // The host has it: nothing comes back to the composer.
  expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('s1'))).toBe('')
})

it('leaves silently once its row loads', async () => {
  const id = await sendRejectedThenClose()
  const reopened = open(REOPENED)
  reopened.rerender({
    submissions: [rejected(id)],
    journalItems: [row(id)],
    journalCursor: { epoch: 'e', sequence: 21 }
  })
  await waitFor(() => expect(reopened.result.current.outbox).toEqual([]))
  expect(mocks.call).toHaveBeenCalledOnce()
  expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('s1'))).toBe('')
})

it("leaves silently once the host's window for it closes", async () => {
  const id = await sendRejectedThenClose()
  const madeAt = Number(id.split('-')[0])
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(madeAt + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS + 1)
  const reopened = open(REOPENED)
  await waitFor(() => expect(reopened.result.current.outbox).toEqual([]))
  expect(mocks.call).toHaveBeenCalledOnce()
  expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('s1'))).toBe('')
})
