import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  relaunch: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {
        'wt-1': [{ contentType: 'agent-session', entityId: 'session-1' }]
      }
    })
  }
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForTab: () => ({ kind: 'local' })
}))
vi.mock('./structured-agent-session-launch', () => ({
  relaunchFailedStructuredAgentSessionForMessage: mocks.relaunch
}))
vi.mock('./active-agent-note-send', () => ({ sendNotesToActiveAgentSession: vi.fn() }))
vi.mock('@/components/native-chat/structured-agent-session-message-sender', () => ({
  sendStructuredAgentSessionMessage: mocks.send
}))

import { sendMessageToAgent } from './agent-message-send'
import { activeAgentNotesSendFailureMessage } from './active-agent-note-send-result'

function sendNotes() {
  return sendMessageToAgent({
    worktreeId: 'wt-1',
    target: { kind: 'structured-session', sessionId: 'session-1' },
    prompt: 'the notes'
  })
}

beforeEach(() => {
  mocks.send.mockReset()
})

// Notes clear only when their message is recorded; any other end keeps them with the caller.
it.each([
  ['recorded', { status: 'sent' }],
  ['returned', { status: 'not-writable', code: 'session-send-refused' }],
  // The host may hold it: the notes stay, worded as unconfirmed, never as refused.
  ['unconfirmed', { status: 'unconfirmed', code: 'runtime-unverifiable' }],
  ['dropped', { status: 'not-writable', code: 'session-send-refused' }]
] as const)('reports notes whose message was %s', async (outcome, result) => {
  mocks.send.mockReturnValue({ clientMessageId: 'm', outcome: Promise.resolve(outcome) })
  await expect(sendNotes()).resolves.toEqual(result)
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-1', text: 'the notes', callerKeepsText: true })
  )
})

it('words unconfirmed notes as the chat does', () => {
  expect(activeAgentNotesSendFailureMessage('unconfirmed', { explicitTarget: true })).toBe(
    "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
  )
})

it('keeps the notes while the chat has a send out', async () => {
  mocks.send.mockReturnValue(null)
  await expect(sendNotes()).resolves.toEqual({
    status: 'not-ready',
    code: 'session-send-refused'
  })
})
