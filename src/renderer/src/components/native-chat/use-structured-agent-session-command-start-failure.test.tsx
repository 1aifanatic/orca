// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
let fence = 3

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      items: [],
      submissions: [],
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
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import { useStructuredAgentSession } from './use-structured-agent-session'

// A /compact on a closed chat starts its agent first; that start taking a new lease moves the
// fence before the reply lands, and the chat's own start-failure row already says why.
it('says nothing under the composer for a /compact whose start failed under a new fence', async () => {
  let reply: (value: unknown) => void = () => {}
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.conversationCommand'
      ? new Promise((resolve) => {
          reply = resolve
        })
      : Promise.resolve(null)
  )
  const { result, rerender } = renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'codex',
      target: { kind: 'local' },
      isVisible: true
    })
  )
  let sent: Promise<{ accepted: boolean; error: string | null }> = Promise.resolve({
    accepted: true,
    error: null
  })
  act(() => {
    sent = result.current.runConversationCommand('compact')
  })
  fence = 5
  rerender()
  await act(async () => {
    reply({
      ok: true,
      replayed: false,
      fence: 3,
      value: {
        command: 'compact',
        state: 'completed',
        error: "Codex couldn't restart. Run /compact again.",
        failure: { kind: 'restartFailed' }
      }
    })
    await sent
  })
  expect(await sent).toEqual({ accepted: false, error: null })
})
