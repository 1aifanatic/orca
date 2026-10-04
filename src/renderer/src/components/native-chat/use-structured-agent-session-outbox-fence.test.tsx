// @vitest-environment happy-dom

// A moved fence is not a reason to send anything again on a host that records every send before it
// starts an agent. There, only a new send, or one still unanswered, goes out. An older host, which restarts the
// agent inside the send and refuses it unrecorded when that fails, keeps the resend on a new fence.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
import { enqueueStructuredAgentSessionLaunchPrompt } from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { readNativeChatDraftCache } from './native-chat-draft-cache'

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const NO_JOURNAL_ITEMS: readonly AgentJournalRenderItem[] = []

// Why: every hook here shares the session outbox store; one left mounted would drain the next test's.
afterEach(cleanup)

const LOCAL_TARGET = { kind: 'local' } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function pendingResult(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending' as const,
        handoverRecorded: true,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    }
  }
}

function sentId(call: number): string {
  const id: unknown = mocks.call.mock.calls[call]?.[2].envelope.clientOperationId
  return String(id)
}

function render(fence: number | null = 1) {
  return renderHook(
    (props) =>
      useStructuredAgentSessionOutbox({
        journalItems: NO_JOURNAL_ITEMS,
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        fence: props.fence,
        submissions: []
      }),
    { initialProps: { fence } }
  )
}

/** Long enough for any effect a fence change schedules to have sent. */
async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
}

describe('an outbox on a host that accepts a send before any agent has it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it('neither resends nor drops the answer of a send in flight when the fence moves', async () => {
    const answer = deferred<ReturnType<typeof pendingResult>>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result, rerender } = render()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    // A start or restart on the host moves the fence while the send is out.
    rerender({ fence: 2 })
    rerender({ fence: 3 })
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)

    await act(async () => answer.resolve(pendingResult(sentId(0))))
    // The answer lands: the entry is the host's now, not re-queued behind a moved fence.
    expect(result.current.outbox).toMatchObject([{ state: 'dispatching' }])
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('keeps a send with no answer in doubt across a fence change, and sends it again under its id', async () => {
    mocks.call
      .mockRejectedValueOnce(new Error('send failed'))
      .mockImplementation(async (_target, _method, params) =>
        pendingResult(params.envelope.clientOperationId)
      )
    const { result, rerender } = render()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    rerender({ fence: 2 })
    // No answer is not a failure: the same id goes again, never a new one.
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(sentId(1)).toBe(sentId(0))
  })

  it('keeps a launch prompt whose staging save failed in the chat, unsent, for Orca to try again', async () => {
    const staged = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'launch notes')
    if (!staged) {
      throw new Error('fixture outbox entry was not persisted')
    }
    const { result } = render(null)

    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    let delivery: unknown = 'unsettled'
    void settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      target: { kind: 'local' },
      options: { prompt: 'launch notes' },
      stagedEntry: staged
    })?.then((settled) => {
      delivery = settled
    })
    try {
      await waitFor(() => expect(result.current.outbox).toMatchObject([{ state: 'unconfirmed' }]))
    } finally {
      setItem.mockRestore()
    }
    // Unsaved, it never goes out; the chat holds it and tries again, and the caller waits for that.
    expect(delivery).toBe('unsettled')
    expect(mocks.call).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe('')
    expect(result.current.error).toBe(
      "Couldn't save your message. Orca will keep trying to send it."
    )
  })
})

describe('an outbox on an older host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([])
  })

  it('still resends a send in flight when the fence moves, as the new owner may take it', async () => {
    mocks.call.mockReturnValueOnce(new Promise(() => {})).mockReturnValue(new Promise(() => {}))
    const { result, rerender } = render()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    rerender({ fence: 2 })

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(sentId(1)).toBe(sentId(0))
  })
})
