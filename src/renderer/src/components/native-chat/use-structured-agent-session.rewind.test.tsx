// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  operationId: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  outboxSend: vi.fn(),
  outboxRetry: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: mocks.toastMessage } }))
let fence = 3
let epoch = 'epoch-1'
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []
let queuedMessages: AgentSessionQueuedMessage[] | null = null

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false)
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      epoch,
      cursor: { epoch, sequence: 2 },
      items,
      submissions,
      queuedMessages,
      status: 'ready',
      error: null,
      hasOlder: false
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: mocks.operationId,
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    error: null,
    send: mocks.outboxSend,
    retry: mocks.outboxRetry
  })
}))

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-queued-message-wire'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'
import {
  nativeChatRewindReasonCopy,
  nativeChatRewindReturnedUnknownCopy
} from './native-chat-rewind-copy'

const LOCAL_TARGET = { kind: 'local' } as const

const OPTIONS = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [{ value: 'medium', label: 'Medium' }]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

describe('useStructuredAgentSession rewind RPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    epoch = 'epoch-1'
    submissions = []
    queuedMessages = null
    items = [
      {
        itemId: 'user-1',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Prompt' }] }
      }
    ]
    mocks.operationId.mockReset().mockReturnValue('rewind-operation')
    mocks.call.mockImplementation((_target, method) =>
      Promise.resolve(
        method === 'agentSession.options'
          ? { ...OPTIONS, rewind: { supported: true } }
          : { ok: true, value: { itemId: 'user-1', epoch: 'epoch-2' } }
      )
    )
  })

  it('sends the agreed verb and fingerprint to the execution host and holds sends until reset', async () => {
    const target = { kind: 'environment' as const, environmentId: 'ssh-host' }
    const view = renderHook(() =>
      useStructuredAgentSession({ sessionId: 'session-1', target, agent: 'codex', isVisible: true })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    const { structuredAgentSessionPayloadFingerprint } =
      await import('../../../../shared/structured-agent-session-mutation')
    expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.rewind', {
      envelope: {
        sessionId: 'session-1',
        clientOperationId: 'rewind-operation',
        expectedRuntimeFence: 3,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.rewind',
          sessionId: 'session-1',
          fields: { itemId: 'user-1', expectedEpoch: 'epoch-1' }
        })
      },
      itemId: 'user-1',
      expectedEpoch: 'epoch-1'
    })
    expect(view.result.current.send('stale composer text', [])).toBe(false)
    expect(mocks.toastMessage).toHaveBeenCalledWith(
      'Wait for the conversation to go back to the earlier message.'
    )
    epoch = 'epoch-2'
    items = []
    view.rerender()
    expect(view.result.current.messages).toEqual([])
    expect(view.result.current.rewind.pending).toBe(false)
  })

  it('renders reason-only host refusals without relying on host English', async () => {
    mocks.call.mockImplementation((_target, method) =>
      Promise.resolve(
        method === 'agentSession.options'
          ? { ...OPTIONS, rewind: { supported: true } }
          : {
              ok: false,
              refusal: {
                code: 'agent_session_operation_invalid',
                message: '',
                details: { reason: 'rewindRefused', rewindReason: 'proof-mismatch' }
              }
            }
      )
    )
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'claude',
        isVisible: true
      })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      nativeChatRewindReasonCopy('proof-mismatch')
    )
    expect(view.result.current.error).toBeNull()
  })

  it('explains an older host missing the RPC without claiming an uncertain rewind occurred', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.rewind'
        ? Promise.reject(
            new RuntimeRpcCallError({
              id: '1',
              ok: false,
              error: { code: 'method_not_found', message: 'Unknown method' },
              _meta: { runtimeId: 'runtime' }
            })
          )
        : Promise.resolve({ ...OPTIONS, rewind: { supported: true } })
    )
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      nativeChatRewindReasonCopy('unsupported')
    )
    expect(view.result.current.rewind.pending).toBe(false)
  })

  it('an unknown outcome leaves sending open and returns the message to the composer', async () => {
    // A remote host without the capability throws before anything is sent: the outcome reads unknown.
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.rewind'
        ? Promise.reject(new Error('Rewinding requires a newer Orca server.'))
        : Promise.resolve({ ...OPTIONS, rewind: { supported: true } })
    )
    const onMessageReturned = vi.fn()
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true,
        composerScopeKey: 'unknown-scope',
        rewind: { onMessageReturned }
      })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    expect(readNativeChatDraftCache('unknown-scope')).toContain('Prompt')
    expect(onMessageReturned).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(nativeChatRewindReturnedUnknownCopy())
    expect(view.result.current.error).toBeNull()
    view.result.current.send('Prompt', [])
    view.result.current.retry('message-1')
    expect(mocks.outboxSend).toHaveBeenCalledOnce()
    expect(mocks.outboxRetry).toHaveBeenCalledOnce()
  })

  it("lets the host's in-doubt latch disable only the action", async () => {
    mocks.call.mockResolvedValue({ ...OPTIONS, rewind: { supported: true } })
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true,
        rewind: { hostBlockedReason: 'outcome-unknown' }
      })
    )
    await waitFor(() => expect(view.result.current.rewind.surface).toBeDefined())
    expect(view.result.current.rewind.surface?.disabledReason).toBe(
      nativeChatRewindReasonCopy('outcome-unknown')
    )
    view.result.current.send('Next prompt', [])
    expect(mocks.outboxSend).toHaveBeenCalledOnce()
    expect(view.result.current.error).toBeNull()
  })

  it("holds the action behind the host's queued cards", async () => {
    mocks.call.mockResolvedValue({ ...OPTIONS, rewind: { supported: true } })
    queuedMessages = [
      {
        messageId: 'queued-1',
        position: 0,
        state: 'waiting',
        paused: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Held' }] }
      }
    ]
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(view.result.current.rewind.surface).toBeDefined())
    expect(view.result.current.rewind.disabledReason).toBe(nativeChatRewindReasonCopy('busy'))
  })
})

describe('useStructuredAgentSession rewind support and composer return', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    epoch = 'epoch-1'
    submissions = []
    queuedMessages = null
    items = [
      {
        itemId: 'user-1',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Fix the bug' }] }
      }
    ]
    mocks.operationId.mockReset().mockReturnValue('rewind-operation')
  })

  it('offers no action on a host whose options name no rewind', async () => {
    mocks.call.mockResolvedValue(OPTIONS)
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() =>
      expect(view.result.current.rewind.disabledReason).toBe(
        nativeChatRewindReasonCopy('unsupported')
      )
    )
    expect(view.result.current.rewind.surface).toBeUndefined()
  })

  it('returns the discarded message to the composer after the existing draft', async () => {
    mocks.call.mockImplementation((_target, method) =>
      Promise.resolve(
        method === 'agentSession.options'
          ? { ...OPTIONS, rewind: { supported: true } }
          : { ok: true, value: { itemId: 'user-1', epoch: 'epoch-2' } }
      )
    )
    writeNativeChatDraftCache('rewind-scope', 'Half-typed')
    const view = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true,
        composerScopeKey: 'rewind-scope'
      })
    )
    await waitFor(() => expect(view.result.current.rewind.disabledReason).toBeNull())
    await act(() => view.result.current.rewind.request('user-1', async () => true))
    expect(readNativeChatDraftCache('rewind-scope')).toContain('Half-typed')
    expect(readNativeChatDraftCache('rewind-scope')).toContain('Fix the bug')
  })
})
