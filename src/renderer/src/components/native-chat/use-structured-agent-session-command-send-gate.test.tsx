// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  outboxSend: vi.fn()
}))
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []
let outbox: StructuredAgentSessionOutboxEntry[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
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
  structuredSessionOperationId: () => 'operation-1',
  useStructuredAgentSessionOutbox: () => ({
    outbox,
    error: null,
    send: mocks.outboxSend,
    retry: vi.fn()
  })
}))

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { useStructuredAgentSession } from './use-structured-agent-session'

function answer(text: string, scoped: boolean): AgentJournalRenderItem {
  return {
    itemId: text,
    revision: 0,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    ...(scoped ? { turnScope: { kind: 'thread' as const } } : {})
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.outboxSend.mockReturnValue(true)
  submissions = []
  outbox = []
})

/** Starts `/compact` and leaves its reply outstanding, then sends a message. */
function sendDuringCommand(): boolean {
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.conversationCommand' ? new Promise(() => {}) : Promise.resolve(null)
  )
  const { result } = renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'codex',
      target: { kind: 'local' },
      isVisible: true
    })
  )
  act(() => {
    void result.current.runConversationCommand('compact')
  })
  return result.current.send('typed during the command')
}

it('still refuses a message locally while an older host runs a command', () => {
  items = [answer('from an older host', false)]

  expect(sendDuringCommand()).toBe(false)
  expect(mocks.outboxSend).not.toHaveBeenCalled()
})

it('queues a message typed during a command on a host that runs it as a turn', () => {
  items = [answer('from this host', true)]

  expect(sendDuringCommand()).toBe(true)
  expect(mocks.outboxSend).toHaveBeenCalledOnce()
})

/** Runs `/compact` over a chat whose outbox holds one message in doubt. */
async function compactBesideInDoubt(hostHoldsIt: boolean) {
  items = [answer('from this host', true)]
  outbox = [
    {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'op-doubt',
        sessionId: 'session-1',
        text: 'stopped',
        attachments: [],
        queuedAt: 1
      }),
      state: 'unconfirmed',
      lastAttemptAt: 2
    }
  ]
  submissions = hostHoldsIt
    ? [
        {
          clientMessageId: 'op-doubt',
          fence: 3,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'unknown',
          providerItemId: null,
          reason: 'provider_closed_before_acknowledgement',
          submittedAt: 2,
          resolvedAt: 3,
          recovered: true
        }
      ]
    : []
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.conversationCommand' ? new Promise(() => {}) : Promise.resolve(null)
  )
  const { result } = renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'codex',
      target: { kind: 'local' },
      isVisible: true
    })
  )
  let outcome: { accepted: boolean; error: string | null } | undefined
  await act(async () => {
    void result.current.runConversationCommand('compact').then((settled) => {
      outcome = settled
    })
  })
  return {
    outcome,
    sent: mocks.call.mock.calls.some(([, method]) => method === 'agentSession.conversationCommand')
  }
}

// The host never sends it again and it has no Retry, so it must not hold a command forever.
it('runs a command beside a message in doubt the host holds', async () => {
  expect((await compactBesideInDoubt(true)).sent).toBe(true)
})

it('still waits on a message in doubt the host may never have received', async () => {
  const { outcome, sent } = await compactBesideInDoubt(false)
  expect(sent).toBe(false)
  expect(outcome?.error).toBe(
    'Wait for pending work and messages to finish before using this command.'
  )
})
