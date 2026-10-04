// @vitest-environment happy-dom

// Every desktop chat send ends one of three ways, decided by what the host said: the host's row
// holds it (it leaves the outbox), the host proved it has none (its text goes back to the
// conversation's draft with the reason said once), or no answer yet (the same id goes again, so
// the host's once-per-id record can't deliver it twice).

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

type SentParams = { envelope: { clientOperationId: string }; body: { blocks: { text?: string }[] } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SentParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { getStructuredAgentSessionOutbox } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { resetStructuredAgentSessionChatLinesForTests } from './structured-agent-session-returned-send'

const TARGET = { kind: 'local' } as const
const SCOPE = structuredAgentSessionDraftScopeKey('session-1')

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionChatLinesForTests()
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY])
})

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
})

function sentIds(): string[] {
  return mocks.call.mock.calls.map((call) => call[2].envelope.clientOperationId)
}

function sentTexts(): (string | undefined)[] {
  return mocks.call.mock.calls.map((call) => call[2].body.blocks[0]?.text)
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: dispatchState === 'pending' ? null : 10,
    ...patch
  }
}

function answer(
  params: SentParams,
  dispatchState: AgentJournalSubmission['dispatchState'],
  patch = {}
) {
  const id = params.envelope.clientOperationId
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 10 },
    value: { clientMessageId: id, submission: submission(id, dispatchState, patch) }
  }
}

function transportError(code: string, message: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: 'rpc-1', ok: false, error: { code, message } })
}

function mount(submissions: AgentJournalSubmission[] = []) {
  return renderHook(
    (props: { submissions: AgentJournalSubmission[] }) =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: TARGET,
        fence: 1,
        submissions: props.submissions,
        journalCursor: { epoch: 'epoch-1', sequence: 1 }
      }),
    { initialProps: { submissions } }
  )
}

describe('case 3: no answer yet', () => {
  it('a lost answer goes again under the same id, and the host replay settles it: one message', async () => {
    let calls = 0
    mocks.call.mockImplementation(async (_target, _method, params) => {
      calls += 1
      if (calls === 1) {
        throw transportError(
          'runtime_timeout',
          'Timed out waiting for the remote Orca runtime to respond.'
        )
      }
      return answer(params, 'accepted')
    })
    const { result } = mount()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    // No answer is no failure: nothing on the chat line, nothing handed back.
    expect(result.current.error).toBeNull()
    await waitFor(() => expect(result.current.outbox).toEqual([]), { timeout: 3000 })

    expect(sentIds()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(1)
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(result.current.error).toBeNull()
  })

  it('held through an outage: sending, resent under its id until the host answers, then gone', async () => {
    let calls = 0
    mocks.call.mockImplementation(async (_target, _method, params) => {
      calls += 1
      if (calls <= 2) {
        throw transportError(
          'remote_runtime_unavailable',
          'Could not connect to the remote Orca runtime.'
        )
      }
      return answer(params, 'accepted')
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { result } = mount()
      act(() => expect(result.current.send('during the outage')).toBe(true))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      // Never "not sent": the message stays, with its text, under the same id.
      expect(result.current.outbox).toMatchObject([{ state: 'unconfirmed' }])
      expect(result.current.error).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(result.current.outbox).toEqual([])
      expect(sentIds()).toHaveLength(3)
      expect(new Set(sentIds()).size).toBe(1)
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('on a host whose answers prove nothing, a refused resend goes again instead of coming back', async () => {
    setLocalRuntimeCapabilitiesForTests([])
    let calls = 0
    mocks.call.mockImplementation(async (_target, _method, params) => {
      calls += 1
      if (calls === 1) {
        throw new Error('socket closed')
      }
      if (calls === 2) {
        return { ok: false, refusal: { code: 'agent_session_journal_unreadable', message: 'x' } }
      }
      return answer(params, 'accepted')
    })
    const { result } = mount()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toEqual([]), { timeout: 6000 })
    // An older host can refuse a resent id before looking it up: only the next resend can tell.
    expect(sentIds()).toHaveLength(3)
    expect(new Set(sentIds()).size).toBe(1)
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  }, 10000)

  it("a refused resend Orca can't trust says why once, that it keeps sending, and clears once it lands", async () => {
    setLocalRuntimeCapabilitiesForTests([])
    let calls = 0
    const landed = Promise.withResolvers<void>()
    mocks.call.mockImplementation(async (_target, _method, params) => {
      calls += 1
      if (calls === 1) {
        throw new Error('socket closed')
      }
      if (calls === 2) {
        return { ok: false, refusal: { code: 'agent_session_journal_unreadable', message: 'x' } }
      }
      await landed.promise
      return answer(params, 'accepted')
    })
    const { result } = mount()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(
      () =>
        expect(result.current.error).toBe(
          "Orca couldn't read this chat's saved history. Orca will keep trying to send it."
        ),
      { timeout: 3000 }
    )
    expect(result.current.outbox).toHaveLength(1)
    await waitFor(() => expect(sentIds()).toHaveLength(3), { timeout: 6000 })
    await act(async () => {
      landed.resolve()
    })
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(result.current.error).toBeNull()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  }, 10000)

  it('on a host whose answers prove, the same refused resend comes back to the draft', async () => {
    let calls = 0
    mocks.call.mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('socket closed')
      }
      return { ok: false, refusal: { code: 'agent_session_journal_unreadable', message: 'x' } }
    })
    const { result } = mount()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toEqual([]), { timeout: 3000 })
    expect(sentIds()).toHaveLength(2)
    expect(readNativeChatDraftCache(SCOPE)).toBe('hello')
    expect(result.current.error).not.toBeNull()
  })
})

describe('case 2: the host proved no record', () => {
  it("goes back to the conversation's draft after what is typed, says why once, and never goes again", async () => {
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_operation_capacity', message: 'busy' }
    })
    writeNativeChatDraftCache(SCOPE, 'typed meanwhile')
    const { result } = mount()

    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(readNativeChatDraftCache(SCOPE)).toBe('typed meanwhile\n\nhello')
    expect(result.current.error).not.toBeNull()
    await act(() => new Promise((resolve) => setTimeout(resolve, 1300)))
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('still lands in the draft when the answer comes after the chat view unmounted', async () => {
    const reply = Promise.withResolvers<unknown>()
    mocks.call.mockImplementation(() => reply.promise)
    const view = mount()
    act(() => expect(view.result.current.send('closed before the answer')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    view.unmount()
    await act(async () => {
      reply.resolve({
        ok: false,
        refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
      })
    })

    await waitFor(() => expect(readNativeChatDraftCache(SCOPE)).toBe('closed before the answer'))
    expect(getStructuredAgentSessionOutbox('session-1')).toEqual([])
  })
})

describe('case 1: the host has a record', () => {
  // Addendum 2: a head the host restarted under is the host's row, never a parked barrier.
  it('a head answered recovered-unknown leaves, and the next send goes out with no user action', async () => {
    mocks.call.mockImplementation(async (_target, _method, params) =>
      params.body.blocks[0]?.text === 'first'
        ? answer(params, 'unknown', { recovered: true, reason: 'host restarted' })
        : answer(params, 'accepted')
    )
    const { result } = mount()

    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toEqual([]))

    expect(sentTexts()).toEqual(['first', 'second'])
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(result.current.error).toBeNull()
  })

  it('a head the journal shows recovered-unknown leaves, and the one behind it goes out', async () => {
    mocks.call.mockImplementation(async (_target, _method, params) =>
      params.body.blocks[0]?.text === 'first' ? new Promise(() => {}) : answer(params, 'accepted')
    )
    const view = mount()
    act(() => expect(view.result.current.send('first')).toBe(true))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    act(() => expect(view.result.current.send('second')).toBe(true))
    const firstId = sentIds()[0]!

    view.rerender({
      submissions: [
        submission(firstId, 'unknown', { reason: 'host_restarted_before_acknowledgement' })
      ]
    })

    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))
    await waitFor(() => expect(view.result.current.outbox).toEqual([]))
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })
})
