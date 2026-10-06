// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  operationId: vi.fn(),
  enqueueSettingsWrite: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))
let fence = 3
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false)
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueueSettingsWrite
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      commands: undefined,
      items,
      submissions,
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
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
import { useStructuredAgentSession } from './use-structured-agent-session'

const LOCAL_TARGET = { kind: 'local' } as const

const OPTIONS = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

describe('the send gate the session hands its composer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    items = []
    submissions = []
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : method === 'agentSession.modelCatalog'
          ? Promise.resolve({
              origin: 'unknown',
              unavailable: { reason: 'notSignedIn', account: 'system', expiresInMs: 20_000 }
            })
          : Promise.resolve(null)
    )
  })

  it('blocks a send that starts the agent, never a follow-up queued behind a running turn', async () => {
    const { result, rerender } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-gate',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.unavailable?.reason).toBe('notSignedIn'))
    items = [
      {
        itemId: 'turn-status',
        revision: 0,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'status',
          text: 'Working',
          turnLifecycle: { turnId: 'turn-1', state: 'running', startedAt: 1 }
        }
      }
    ]
    rerender()
    expect(result.current.canStop).toBe(true)
    expect(result.current.unavailable).toBeNull()
    items = []
    rerender()
    expect(result.current.unavailable?.reason).toBe('notSignedIn')
  })
})
