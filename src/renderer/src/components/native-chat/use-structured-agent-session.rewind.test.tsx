// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  operationId: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))
let fence = 3
let epoch = 'epoch-1'
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []

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
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'

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

  it('sends the agreed verb and fingerprint to the execution host and blocks the composer until reset', async () => {
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
    expect(view.result.current.error).toContain('could not verify the conversation boundary')
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
    expect(view.result.current.error).toContain('does not support rewinding')
    expect(view.result.current.rewind.pending).toBe(false)
  })
})

describe('useStructuredAgentSession rewind support and composer return', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    epoch = 'epoch-1'
    submissions = []
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

  it('treats a host whose options name no rewind as unsupported', async () => {
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
      expect(view.result.current.rewind.disabledReason).toContain('does not support rewinding')
    )
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
