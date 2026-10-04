// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusalCode } from '../../../../shared/agent-session-wire'
import { enqueueStructuredAgentSessionLaunchPrompt } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { resetStructuredAgentSessionChatLinesForTests } from './structured-agent-session-returned-send'

const mocks = vi.hoisted(() => ({
  call: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'

// Why: every hook here shares the session outbox store; one left mounted would drain the next test's.
afterEach(cleanup)

const LOCAL_TARGET = { kind: 'local' } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, reject, resolve }
}

function acceptedResult(fence: number) {
  return {
    ok: true,
    replayed: false,
    fence,
    cursor: { epoch: 'epoch-1', sequence: fence },
    value: {
      clientMessageId: 'client-1',
      submission: {
        clientMessageId: 'client-1',
        fence,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: 'provider-1',
        reason: null,
        submittedAt: fence,
        resolvedAt: fence
      }
    }
  }
}

function acceptedResultFor(clientMessageId: string, fence: number) {
  return {
    ok: true,
    replayed: false,
    fence,
    cursor: { epoch: 'epoch-1', sequence: fence },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: `provider-${clientMessageId}`,
        reason: null,
        submittedAt: fence,
        resolvedAt: fence
      }
    }
  }
}

function unknownResultFor(clientMessageId: string, submittedAt: number) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: submittedAt },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'unknown' as const,
        providerItemId: null,
        reason: 'socket closed',
        submittedAt,
        resolvedAt: submittedAt
      }
    }
  }
}

function pendingResultFor(clientMessageId: string, submittedAt: number) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: submittedAt },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending' as const,
        providerItemId: null,
        reason: null,
        submittedAt,
        resolvedAt: null
      }
    }
  }
}

function refusedResult(code: AgentSessionWireRefusalCode) {
  return { ok: false, refusal: { code, message: code } }
}

/** The operation id a request carried, read without trusting its shape. */
function sentOperationId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('envelope' in params)) {
    return undefined
  }
  const { envelope } = params
  return typeof envelope === 'object' &&
    envelope !== null &&
    'clientOperationId' in envelope &&
    typeof envelope.clientOperationId === 'string'
    ? envelope.clientOperationId
    : undefined
}

describe('useStructuredAgentSessionOutbox', () => {
  let randomUuidSequence = 0

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearNativeChatDraftCacheForTests()
    resetStructuredAgentSessionChatLinesForTests()
    randomUuidSequence = 0
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      randomUuidSequence += 1
      return `11111111-1111-4111-8111-${randomUuidSequence.toString(16).padStart(12, '0')}`
    })
  })

  it('does not redispatch a launch prompt settled before the mounted outbox gets its fence', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    if (!stagedEntry) {
      throw new Error('fixture outbox entry was not persisted')
    }
    mocks.call.mockResolvedValue(acceptedResultFor(stagedEntry.clientMessageId, 1))
    const initialProps: { fence: number | null } = { fence: null }
    const { result, rerender } = renderHook(
      ({ fence }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence,
          submissions: []
        }),
      { initialProps }
    )
    expect(result.current.outbox).toHaveLength(1)

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        target: { kind: 'local' },
        options: { prompt: 'review this' },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(mocks.call).toHaveBeenCalledOnce()

    rerender({ fence: 1 })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('joins a launch prompt dispatch already in flight when the outbox mounts', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    if (!stagedEntry) {
      throw new Error('fixture outbox entry was not persisted')
    }
    const admission = deferred<ReturnType<typeof acceptedResultFor>>()
    mocks.call.mockReturnValueOnce(admission.promise)
    const delivery = settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      target: { kind: 'local' },
      options: { prompt: 'review this' },
      stagedEntry
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )
    expect(result.current.outbox[0]?.state).toBe('dispatching')

    await act(async () => admission.resolve(acceptedResultFor(stagedEntry.clientMessageId, 1)))
    await expect(delivery).resolves.toEqual({ delivered: true, failureNotified: false })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('requeues across a fence change and ignores the stale settlement', async () => {
    const first = deferred<ReturnType<typeof acceptedResult>>()
    const second = deferred<ReturnType<typeof acceptedResult>>()
    mocks.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(
      ({ fence }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence,
          submissions: []
        }),
      { initialProps: { fence: 1 } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))

    rerender({ fence: 2 })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call.mock.calls[1]?.[2]).toMatchObject({
      envelope: { expectedRuntimeFence: 2 }
    })

    await act(async () => first.resolve(acceptedResult(1)))
    expect(result.current.outbox).toHaveLength(1)

    await act(async () => second.resolve(acceptedResult(2)))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
  })

  it.each([
    ['agent_session_operation_conflict', 'Your message was not sent.'],
    [
      'agent_session_operation_expired',
      "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
    ]
  ] as const)(
    'gives a first attempt the host refused with %s back to the chat draft, once',
    async (code, words) => {
      mocks.call.mockResolvedValueOnce(refusedResult(code))
      const { result } = renderHook(() =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions: []
        })
      )

      act(() => expect(result.current.send('hello')).toBe(true))
      await waitFor(() => expect(result.current.outbox).toHaveLength(0))
      expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe(
        'hello'
      )
      expect(result.current.error).toBe(words)
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(mocks.call).toHaveBeenCalledOnce()
    }
  )

  it('leaves an admitted send dispatching, never unconfirmed', async () => {
    mocks.call.mockImplementationOnce(async (_target, _method, params) => {
      const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
        .clientOperationId
      return pendingResultFor(clientMessageId, 10)
    })
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )

    act(() => expect(result.current.send('queued behind a running turn')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    const id = result.current.outbox[0]!.clientMessageId
    // Written and awaiting the provider's acknowledgement: no doubt, no banner.
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('dispatching'))
    expect(result.current.error).toBeNull()

    // A long-lived `pending` submission republished keeps it out of doubt.
    rerender({
      submissions: [pendingResultFor(id, 10).value.submission]
    })
    expect(result.current.outbox[0]?.state).toBe('dispatching')
    expect(mocks.call).toHaveBeenCalledTimes(1)

    // The provider's echo lands and settles it; the entry leaves the outbox.
    rerender({
      submissions: [
        { ...pendingResultFor(id, 10).value.submission, dispatchState: 'accepted' as const }
      ]
    })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(result.current.error).toBeNull()
  })

  it('lets no transport error reopen a send the journal already settled', async () => {
    // The RPC fails while the host has already accepted: the journal is the
    // authority, so the entry leaves the outbox and no Retry is offered for it.
    mocks.call.mockRejectedValue(new Error('socket closed'))
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )

    act(() => expect(result.current.send('settled for good')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    const id = result.current.outbox[0]!.clientMessageId
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    // No answer is no failure: nothing on the chat line, and the text stays on its bubble.
    expect(result.current.error).toBeNull()

    rerender({
      submissions: [
        { ...pendingResultFor(id, 10).value.submission, dispatchState: 'accepted' as const }
      ]
    })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(result.current.error).toBeNull()
  })

  it('ignores a transport failure after the journal already settled the send', async () => {
    const inFlight = deferred<ReturnType<typeof acceptedResult>>()
    mocks.call.mockReturnValueOnce(inFlight.promise)
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )

    act(() => expect(result.current.send('settled before the RPC')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const id = result.current.outbox[0]!.clientMessageId
    rerender({
      submissions: [
        { ...pendingResultFor(id, 10).value.submission, dispatchState: 'accepted' as const }
      ]
    })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))

    await act(async () => inFlight.reject(new Error('socket closed')))
    expect(result.current.outbox).toHaveLength(0)
    expect(result.current.error).toBeNull()
  })

  it('ignores a transport failure after the host admitted the send', async () => {
    const inFlight = deferred<ReturnType<typeof acceptedResult>>()
    mocks.call.mockReturnValueOnce(inFlight.promise)
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )

    act(() => expect(result.current.send('admitted before the RPC')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const id = result.current.outbox[0]!.clientMessageId
    rerender({ submissions: [pendingResultFor(id, 10).value.submission] })
    expect(result.current.outbox[0]?.state).toBe('dispatching')

    await act(async () => inFlight.reject(new Error('socket closed')))
    expect(result.current.outbox[0]?.state).toBe('dispatching')
    expect(result.current.error).toBeNull()
  })

  it('keeps a failed tail-save error when the admitted head is republished', async () => {
    const inFlight = deferred<ReturnType<typeof acceptedResult>>()
    mocks.call.mockReturnValueOnce(inFlight.promise)
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )

    act(() => expect(result.current.send('admitted head')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const id = result.current.outbox[0]!.clientMessageId
    rerender({ submissions: [pendingResultFor(id, 10).value.submission] })
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage full')
    })
    act(() => expect(result.current.send('tail that cannot be saved')).toBe(false))
    expect(result.current.error).toBe("Couldn't save your message. Try again.")

    rerender({ submissions: [{ ...pendingResultFor(id, 10).value.submission }] })
    expect(result.current.error).toBe("Couldn't save your message. Try again.")
    setItem.mockRestore()
  })

  it('restores a persisted admitted send from host pending state', async () => {
    mocks.call.mockImplementationOnce(async (_target, _method, params) => {
      const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
        .clientOperationId
      return pendingResultFor(clientMessageId, 10)
    })
    const first = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(first.result.current.send('still waiting behind a turn')).toBe(true))
    await waitFor(() => expect(first.result.current.outbox[0]?.state).toBe('dispatching'))
    const id = first.result.current.outbox[0]!.clientMessageId
    first.unmount()

    const restored = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: [pendingResultFor(id, 10).value.submission]
      })
    )
    await waitFor(() => expect(restored.result.current.outbox[0]?.state).toBe('dispatching'))
    expect(restored.result.current.error).toBeNull()
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('lets a head the host answers with a row in doubt leave, so the queue behind it advances', async () => {
    // The host has a record of it, so the row shows it from here: nothing waits on the user.
    mocks.call.mockImplementation(async (_target, _method, params) => {
      const request = params as {
        envelope: { clientOperationId: string }
        body: { blocks: { text?: string }[] }
      }
      if (request.body.blocks[0]?.text === 'second') {
        return acceptedResultFor(request.envelope.clientOperationId, 11)
      }
      return unknownResultFor(request.envelope.clientOperationId, 10)
    })
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('first')).toBe(true))
    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))

    const sent = mocks.call.mock.calls.map(
      (call) => (call[2] as { body?: { blocks?: { text?: string }[] } })?.body?.blocks?.[0]?.text
    )
    expect(sent).toEqual(['first', 'second'])
    expect(result.current.error).toBeNull()
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe('')
  })

  it('gives a message back to the draft when the host could not restart the agent, saying why once', async () => {
    const message = "Claude couldn't restart: Not logged in. Please run /login."
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_owner_restart_failed', message }
    })
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe('hello')
    expect(result.current.error).not.toBeNull()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    // Never sent again on its own: sending it again is the user's new message.
    expect(mocks.call).toHaveBeenCalledOnce()

    // The next send clears the line.
    mocks.call.mockResolvedValue(acceptedResult(1))
    act(() => expect(result.current.send('again')).toBe(true))
    expect(result.current.error).toBeNull()
  })

  it('persists and dispatches an attachment-only structured send', async () => {
    mocks.call.mockResolvedValue(acceptedResult(1))
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    act(() =>
      expect(
        result.current.send('', [{ path: '/tmp/image.png', previewUri: 'file:///tmp/image.png' }])
      ).toBe(true)
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', path: '/tmp/image.png' }]
      }
    })
  })

  it('lets a head the journal rejects leave without a resend, so the queued tail advances', async () => {
    mocks.call
      .mockImplementationOnce(async () => {
        throw new Error('socket closed')
      })
      .mockImplementation(async (_target, _method, params) =>
        acceptedResultFor(
          (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId,
          11
        )
      )
    const { result, rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    const firstId = result.current.outbox[0]!.clientMessageId
    act(() => expect(result.current.send('second')).toBe(true))
    rerender({
      submissions: [
        {
          clientMessageId: firstId,
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'rejected',
          providerItemId: null,
          reason: 'not_delivered',
          submittedAt: 10,
          resolvedAt: 10
        }
      ]
    })

    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    const ids = mocks.call.mock.calls.map((call) => sentOperationId(call[2]))
    // The first went once; its row says it was not sent, and its text is not handed back.
    expect(ids.filter((id) => id === firstId)).toHaveLength(1)
    expect(ids).toHaveLength(2)
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe('')
  })

  it('leaves a send the host recorded and rejected to its row: no resend, nothing handed back', async () => {
    const writeFailed = (clientMessageId: string) => ({
      clientMessageId,
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'rejected' as const,
      providerItemId: null,
      reason: 'provider_write_failed: broken pipe',
      submittedAt: 10,
      resolvedAt: 10
    })
    mocks.call.mockImplementation(async (_target, _method, params) => {
      const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
        .clientOperationId
      return {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 10 },
        value: { clientMessageId, submission: writeFailed(clientMessageId) }
      }
    })
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
    )

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(result.current.error).toBeNull()
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe('')
  })

  it('loads the new session outbox when a pane switches sessions', async () => {
    mocks.call.mockImplementationOnce(async () => {
      throw new Error('socket closed')
    })

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useStructuredAgentSessionOutbox({
          sessionId,
          target: LOCAL_TARGET,
          fence: 1,
          submissions: []
        }),
      { initialProps: { sessionId: 'session-1' } }
    )

    act(() => expect(result.current.send('first session')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))

    rerender({ sessionId: 'session-2' })
    expect(result.current.outbox).toHaveLength(0)

    act(() => expect(result.current.send('second session')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call.mock.calls[1]?.[2]).toMatchObject({
      envelope: { sessionId: 'session-2' },
      body: {
        blocks: [{ type: 'text', text: 'second session' }]
      }
    })
  })

  it("keeps a chat's line to that chat: another session never shows it", async () => {
    const redispatch = deferred<ReturnType<typeof acceptedResult>>()
    mocks.call
      .mockResolvedValueOnce(refusedResult('agent_session_checkpoint_stale'))
      .mockReturnValueOnce(redispatch.promise)
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useStructuredAgentSessionOutbox({
          sessionId,
          target: LOCAL_TARGET,
          fence: 1,
          submissions: []
        }),
      { initialProps: { sessionId: 'session-1' } }
    )

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    const line = result.current.error

    rerender({ sessionId: 'session-2' })
    expect(result.current.error).toBeNull()

    // Its text is still in that chat's draft, so the line still says why.
    rerender({ sessionId: 'session-1' })
    expect(result.current.error).toBe(line)
  })

  it('invalidates an old dispatch before it settles during a session switch', async () => {
    const oldDispatch = deferred<ReturnType<typeof refusedResult>>()
    const sessionTwoCommitted = deferred<void>()
    mocks.call.mockReturnValueOnce(oldDispatch.promise)
    const controllerRef: {
      current: ReturnType<typeof useStructuredAgentSessionOutbox> | null
    } = { current: null }
    function Probe({ sessionId }: { sessionId: string }): null {
      controllerRef.current = useStructuredAgentSessionOutbox({
        sessionId,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: []
      })
      useLayoutEffect(() => {
        if (sessionId === 'session-2') {
          oldDispatch.resolve(refusedResult('agent_session_checkpoint_stale'))
          sessionTwoCommitted.resolve()
        }
      }, [sessionId])
      return null
    }

    const container = document.createElement('div')
    const root = createRoot(container)
    const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    try {
      await act(async () => root.render(<Probe sessionId="session-1" />))
      act(() => expect(controllerRef.current?.send('hello')).toBe(true))
      await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
      const oldSettlementProcessed = oldDispatch.promise.then(() => undefined)

      globalThis.IS_REACT_ACT_ENVIRONMENT = false
      root.render(<Probe sessionId="session-2" />)
      await sessionTwoCommitted.promise
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      await act(async () => oldSettlementProcessed)

      expect(controllerRef.current?.error).toBeNull()
      await act(async () => root.render(<Probe sessionId="session-1" />))
      expect(controllerRef.current?.error).toBeNull()
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      await act(async () => root.unmount())
    }
  })
})
