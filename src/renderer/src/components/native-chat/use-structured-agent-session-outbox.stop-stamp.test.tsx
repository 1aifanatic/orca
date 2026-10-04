// @vitest-environment happy-dom

// A send already on its way when the user presses Stop is stamped with the Stop's own id and never
// sent again: a resend onto the session the user stopped would start a turn they just stopped. Its
// own answer, its journal row, or the Stop's answer read through the journal settles it.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

type SentParams = { envelope: { clientOperationId: string }; delivery?: string }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SentParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { resetStructuredAgentSessionChatLinesForTests } from './structured-agent-session-returned-send'

// Why: every hook here shares the session outbox store; one left mounted would drain the next test's.
afterEach(cleanup)

const TARGET = { kind: 'local' } as const
const REMOTE = { kind: 'environment', environmentId: 'env-1' } as const
const SCOPE = structuredAgentSessionDraftScopeKey('session-1')
const CHECK_THE_CHAT =
  "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."

type Props = {
  fence: number | null
  submissions: AgentJournalSubmission[]
  journalCursor: AgentJournalCursor | null
  queuedMessageIds?: string[]
}

function accepted(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'accepted',
    providerItemId: 'provider-1',
    reason: null,
    submittedAt: 10,
    resolvedAt: 10
  }
}

function mount(initialProps: Props, target: typeof TARGET | typeof REMOTE = TARGET, queue = false) {
  return renderHook(
    (props: Props) =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target,
        fence: props.fence,
        submissions: props.submissions,
        journalCursor: props.journalCursor,
        ...(props.queuedMessageIds ? { queuedMessageIds: props.queuedMessageIds } : {}),
        queueDelivery: queue
          ? { capability: 'supported', enabled: true }
          : { capability: 'unsupported', enabled: false }
      }),
    { initialProps }
  )
}

function seedAttempted(patch: Record<string, unknown> = {}): void {
  writeOutbox('session-1', [
    {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'out',
        sessionId: 'session-1',
        text: 'follow-up',
        attachments: [],
        queuedAt: 1
      }),
      lastAttemptAt: 5,
      state: 'unconfirmed',
      ...patch
    }
  ])
}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionChatLinesForTests()
  mocks.call.mockReset()
  mocks.call.mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('a send a Stop outran', () => {
  it('is never sent again, then comes back silently once the journal is read through the Stop', async () => {
    // Lost answer; the resend flipped it back to queued; the Stop lands before the drain sends it.
    seedAttempted({ state: 'queued', sentDelivery: 'queue-if-active' })
    const view = mount({ fence: null, submissions: [], journalCursor: null }, REMOTE, true)
    act(() => view.result.current.stop('stop-1'))
    // The host may hold it as a paused card: the composer gets nothing yet.
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    view.rerender({ fence: 1, submissions: [], journalCursor: { epoch: 'e', sequence: 3 } })
    // Past the resend's longest backoff several times over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.call).not.toHaveBeenCalled()

    act(() =>
      view.result.current.recordStopAnswer('stop-1', {
        kind: 'answered',
        cursor: { epoch: 'e', sequence: 7 }
      })
    )
    // Read through the Stop, but no draft list yet: a queued draft is no journal row.
    view.rerender({ fence: 1, submissions: [], journalCursor: { epoch: 'e', sequence: 7 } })
    expect(view.result.current.outbox).toHaveLength(1)
    view.rerender({
      fence: 1,
      submissions: [],
      journalCursor: { epoch: 'e', sequence: 7 },
      queuedMessageIds: []
    })
    expect(view.result.current.outbox).toEqual([])
    expect(readNativeChatDraftCache(SCOPE)).toBe('follow-up')
    // The user stopped it: nothing failed, so nothing is said.
    expect(view.result.current.error).toBeNull()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('in flight at the Stop, its answer lost: never resent; its row once the Stop answers drops it', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockImplementationOnce(() => answer.promise)
    const view = mount({ fence: 1, submissions: [], journalCursor: { epoch: 'e', sequence: 1 } })
    act(() => {
      view.result.current.send('follow-up')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const id = mocks.call.mock.calls[0]?.[2].envelope.clientOperationId ?? ''
    act(() => view.result.current.stop('stop-1'))
    await act(async () => {
      answer.reject(new Error('connection closed'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    // No answer leaves it waiting for the Stop's; the call count stays one.
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(readOutbox('session-1')).toMatchObject([
      { clientMessageId: id, stoppedBy: { operationId: 'stop-1' } }
    ])

    act(() =>
      view.result.current.recordStopAnswer('stop-1', {
        kind: 'answered',
        cursor: { epoch: 'e', sequence: 5 }
      })
    )
    view.rerender({
      fence: 1,
      submissions: [accepted(id)],
      journalCursor: { epoch: 'e', sequence: 5 }
    })
    expect(view.result.current.outbox).toEqual([])
    // The host has it: the row shows it, and nothing is handed back.
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('in flight at the Stop, its answer lost, no row by the Stop: back in the draft silently', async () => {
    mocks.call.mockRejectedValueOnce(new Error('connection closed'))
    const view = mount({ fence: 1, submissions: [], journalCursor: { epoch: 'e', sequence: 1 } })
    act(() => {
      view.result.current.send('follow-up')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => view.result.current.stop('stop-1'))
    act(() =>
      view.result.current.recordStopAnswer('stop-1', {
        kind: 'answered',
        cursor: { epoch: 'e', sequence: 5 }
      })
    )
    view.rerender({ fence: 1, submissions: [], journalCursor: { epoch: 'e', sequence: 5 } })
    expect(view.result.current.outbox).toEqual([])
    expect(readNativeChatDraftCache(SCOPE)).toBe('follow-up')
    expect(view.result.current.error).toBeNull()
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('a refused Stop hands it back to check the chat, once the journal has loaded with no row', async () => {
    seedAttempted()
    const view = mount({ fence: 1, submissions: [], journalCursor: null })
    act(() => view.result.current.stop('stop-1'))
    act(() => view.result.current.recordStopAnswer('stop-1', { kind: 'unanswerable' }))
    // Not loaded: nothing can say yet.
    expect(view.result.current.outbox).toHaveLength(1)
    view.rerender({ fence: 1, submissions: [], journalCursor: { epoch: 'e', sequence: 2 } })
    expect(view.result.current.outbox).toEqual([])
    expect(readNativeChatDraftCache(SCOPE)).toBe('follow-up')
    expect(view.result.current.error).toBe(CHECK_THE_CHAT)
    expect(mocks.call).not.toHaveBeenCalled()
  })
})

describe('a message an older build held for a Retry', () => {
  it.each([
    ['outlived by a Stop', { outlivedStop: true, state: 'queued' }],
    ['rejected', { state: 'rejected', lastFailure: { kind: 'rejected', reason: null } }],
    ['held with its failure', { state: 'queued', lastFailure: { kind: 'failed' } }]
  ])('one %s is never sent, and settles once the journal loads', async (_label, saved) => {
    seedAttempted(saved)
    const view = mount({ fence: 1, submissions: [], journalCursor: null })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.call).not.toHaveBeenCalled()
    expect(view.result.current.outbox).toMatchObject([{ legacyUnsettled: true }])

    // No row: the person was told it did not go, so it comes back, with words to check the chat.
    view.rerender({ fence: 1, submissions: [], journalCursor: { epoch: 'e', sequence: 2 } })
    expect(view.result.current.outbox).toEqual([])
    expect(readNativeChatDraftCache(SCOPE)).toBe('follow-up')
    expect(view.result.current.error).toBe(CHECK_THE_CHAT)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('one the journal holds a row for is dropped, with nothing handed back', async () => {
    seedAttempted({ state: 'rejected' })
    const view = mount({ fence: 1, submissions: [], journalCursor: null })
    view.rerender({
      fence: 1,
      submissions: [{ ...accepted('out'), dispatchState: 'rejected', reason: 'not_delivered' }],
      journalCursor: { epoch: 'e', sequence: 2 }
    })
    expect(view.result.current.outbox).toEqual([])
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(view.result.current.error).toBeNull()
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
