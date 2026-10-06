// What a Stop does to the messages this client sent that the host does not hold yet: nothing may go
// out after the Stop. One that never went out comes back to the composer; one on its way is stamped
// with the Stop's own id and never sent again; one the host holds is the journal's to settle.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  hasUnsentStructuredAgentSessionOutboxEntry,
  stopStructuredAgentSessionOutbox
} from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'

type SendRequest = { body?: { blocks?: { text?: string }[] } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SendRequest) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { readOutbox } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'

const NO_JOURNAL_ITEMS: readonly AgentJournalRenderItem[] = []

// One object: a target rebuilt each render reads as a new owner, which re-sends what is on its way.
const TARGET = { kind: 'local' } as const

function sentTexts(): (string | undefined)[] {
  return mocks.call.mock.calls.map((call) => call[2].body?.blocks?.[0]?.text)
}

function pending(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: null,
    handoverRecorded: true
  }
}

function entry(
  clientMessageId: string,
  state: StructuredAgentSessionOutboxEntry['state']
): StructuredAgentSessionOutboxEntry {
  return {
    clientMessageId,
    sessionId: 'session-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
    previewUris: [],
    state,
    queuedAt: 1,
    lastAttemptAt: state === 'queued' ? null : 2
  }
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  let uuid = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1
    return `11111111-1111-4111-8111-${uuid.toString(16).padStart(12, '0')}`
  })
})

describe('a Stop withdrawing what the host does not hold', () => {
  it('leaves the send on its way to the host and keeps every message behind it from going out', async () => {
    const reply = Promise.withResolvers<unknown>()
    mocks.call.mockImplementation((_target, _method, params) =>
      params.body?.blocks?.[0]?.text === 'first' ? reply.promise : new Promise<never>(() => {})
    )
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        journalItems: NO_JOURNAL_ITEMS,
        sessionId: 'session-1',
        target: TARGET,
        fence: 1,
        submissions: []
      })
    )
    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    act(() => expect(result.current.send('second')).toBe(true))
    const firstId = result.current.outbox[0]!.clientMessageId

    act(() => result.current.stop('stop-1'))
    // The one that never left is back in the composer, once the drafts' startup load is in.
    await waitFor(() =>
      expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe(
        'second'
      )
    )
    await act(async () =>
      reply.resolve({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 10 },
        value: { clientMessageId: firstId, submission: pending(firstId) }
      })
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))

    // The host's answer to it, not this Stop, decides whether it comes back.
    expect(result.current.outbox.map((candidate) => candidate.clientMessageId)).toEqual([firstId])
    expect(readOutbox('session-1').map((candidate) => candidate.clientMessageId)).toEqual([firstId])
    expect(sentTexts()).toEqual(['first'])
  })

  it('leaves what the journal holds to the host, and stamps what is on its way', () => {
    const entries = [
      entry('held', 'dispatching'),
      entry('in-doubt', 'unconfirmed'),
      entry('local', 'queued')
    ]

    const stopped = stopStructuredAgentSessionOutbox(entries, [pending('held')], null, 'stop-1')
    expect(
      stopped.entries.map((candidate) => [candidate.clientMessageId, candidate.stoppedBy])
    ).toEqual([
      ['held', undefined],
      ['in-doubt', { operationId: 'stop-1' }]
    ])
    expect(stopped.withdrawn.map((candidate) => candidate.clientMessageId)).toEqual(['local'])
  })

  it('stamps the send in flight even before its first answer, and never a second time', () => {
    const inFlight = { ...entry('in-flight', 'dispatching'), lastAttemptAt: null }
    const stopped = stopStructuredAgentSessionOutbox([inFlight], [], 'in-flight', 'stop-1')
    expect(stopped.entries[0]?.stoppedBy).toEqual({ operationId: 'stop-1' })
    // A later Stop leaves it with the first: its answer is what it waits for.
    const again = stopStructuredAgentSessionOutbox(stopped.entries, [], null, 'stop-2')
    expect(again.entries[0]?.stoppedBy).toEqual({ operationId: 'stop-1' })
    expect(hasUnsentStructuredAgentSessionOutboxEntry(stopped.entries, [])).toBe(false)
    expect(hasUnsentStructuredAgentSessionOutboxEntry([inFlight], [])).toBe(true)
  })

  it('keeps a message with no answer, stamped, and never sends it again', async () => {
    mocks.call.mockRejectedValue(new Error('socket closed'))
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        journalItems: NO_JOURNAL_ITEMS,
        sessionId: 'session-1',
        target: TARGET,
        fence: 1,
        submissions: []
      })
    )
    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))

    act(() => result.current.stop('stop-1'))
    // Past the resend's first delay: nothing goes again.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1300)))

    expect(mocks.call).toHaveBeenCalledOnce()
    expect(readOutbox('session-1')).toMatchObject([{ stoppedBy: { operationId: 'stop-1' } }])
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe('')
  })
})
