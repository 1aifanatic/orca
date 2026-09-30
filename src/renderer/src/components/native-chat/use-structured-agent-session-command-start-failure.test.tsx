// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'

const mocks = vi.hoisted(() => ({ call: vi.fn(), toastError: vi.fn() }))
let fence = 3
let items: AgentJournalRenderItem[] = []

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      items,
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

import { i18n } from '@/i18n/i18n'
import { useStructuredAgentSession } from './use-structured-agent-session'

type Pane = { sessionId: string; transportEnabled: boolean }

const RESTART_FAILED: AgentSessionFailureFact = { kind: 'restartFailed' }
const NOT_SIGNED_IN: AgentSessionFailureFact = { kind: 'notSignedIn' }

function startFailureRow(fact: AgentSessionFailureFact): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('start-1')),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { agentName: 'Codex', surface: 'row' })
    }
  }
}

function commandReply(
  command: 'clear' | 'compact',
  failure?: AgentSessionFailureFact
): { ok: true; replayed: false; fence: number; value: unknown } {
  const words = failure
    ? agentSessionFailureWords(failure, { agentName: 'Codex', command, surface: 'row' })
    : undefined
  return {
    ok: true,
    replayed: false,
    fence: 3,
    value: {
      command,
      state: 'completed',
      ...(words ? { error: words.text, failure: words.failure } : {})
    }
  }
}

// Holds every write open until the test answers it, so the fence can move in between.
function heldWrites(): (reply: unknown) => void {
  let answer: (value: unknown) => void = () => {}
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.conversationCommand' || method === 'agentSession.cancel'
      ? new Promise((resolve) => {
          answer = resolve
        })
      : Promise.resolve(null)
  )
  return (reply) => answer(reply)
}

function renderPane() {
  return renderHook(
    (pane: Pane) =>
      useStructuredAgentSession({
        sessionId: pane.sessionId,
        agent: 'codex',
        target: { kind: 'local' },
        isVisible: true,
        transportEnabled: pane.transportEnabled
      }),
    { initialProps: { sessionId: 'session-1', transportEnabled: true } }
  )
}

// A command on a chat at rest starts its agent first; that start takes a new lease and moves the
// fence before the command's reply lands. The reply still answers what this pane asked.
async function commandAcrossFenceMove(
  command: 'clear' | 'compact',
  reply: unknown,
  pane: Pane = { sessionId: 'session-1', transportEnabled: true },
  rowsAfterStart: AgentJournalRenderItem[] = items
): Promise<{ accepted: boolean; error: string | null }> {
  const answer = heldWrites()
  const { result, rerender } = renderPane()
  let sent: Promise<{ accepted: boolean; error: string | null }> = Promise.resolve({
    accepted: true,
    error: null
  })
  act(() => {
    sent = result.current.runConversationCommand(command)
  })
  fence = 5
  items = rowsAfterStart
  rerender(pane)
  await act(async () => {
    answer(reply)
    await sent
  })
  return sent
}

beforeEach(() => {
  vi.clearAllMocks()
  fence = 3
  items = []
})

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('a conversation command whose own start moved the fence', () => {
  it("shows why a /clear's new chat did not start, in the reader's language", async () => {
    await i18n.changeLanguage('fr')
    // A row the source chat kept from an earlier start is not the new chat's failure.
    items = [startFailureRow(NOT_SIGNED_IN)]
    const reply = commandReply('clear', NOT_SIGNED_IN)
    const outcome = await commandAcrossFenceMove('clear', reply)
    expect(outcome.accepted).toBe(false)
    expect(outcome.error).toMatch(/^Codex n'est pas connecté/)
    expect(outcome.error).toContain('/clear')
  })

  it('clears the draft for a /compact that started', async () => {
    expect(await commandAcrossFenceMove('compact', commandReply('compact'))).toEqual({
      accepted: true,
      error: null
    })
  })

  it("says nothing for a /compact whose start failed, when that start's row is loaded", async () => {
    // The row arrives with the new fence, after the command was sent.
    expect(
      await commandAcrossFenceMove('compact', commandReply('compact', RESTART_FAILED), undefined, [
        startFailureRow(RESTART_FAILED)
      ])
    ).toEqual({ accepted: false, error: null })
  })

  it("says why a /compact's start failed while its row is not loaded", async () => {
    expect(
      await commandAcrossFenceMove('compact', commandReply('compact', RESTART_FAILED))
    ).toEqual({ accepted: false, error: "Codex couldn't restart. Run /compact again." })
  })

  it("shows the host's refusal of a command that arrives after the fence moved", async () => {
    const outcome = await commandAcrossFenceMove('compact', {
      ok: false,
      refusal: {
        code: 'agent_session_conflict',
        message: 'Orca log text.',
        retryable: false
      }
    })
    expect(outcome).toEqual({ accepted: false, error: "The command didn't run." })
  })

  it('drops a reply once the pane has moved to another chat or closed', async () => {
    for (const pane of [
      { sessionId: 'session-2', transportEnabled: true },
      { sessionId: 'session-1', transportEnabled: false }
    ]) {
      fence = 3
      expect(
        await commandAcrossFenceMove('clear', commandReply('clear', NOT_SIGNED_IN), pane)
      ).toEqual({ accepted: false, error: null })
    }
  })
})

describe('any other write across a fence move', () => {
  it('drops the result: it answered for the runtime this pane replaced', async () => {
    const answer = heldWrites()
    const { result, rerender } = renderPane()
    let stopped: Promise<unknown> = Promise.resolve('unset')
    act(() => {
      stopped = result.current.cancel('turn-1')
    })
    fence = 5
    rerender({ sessionId: 'session-1', transportEnabled: true })
    await act(async () => {
      answer({ ok: true, replayed: false, fence: 3, value: { cancelled: true } })
      await stopped
    })
    expect(await stopped).toBeNull()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps a result the same fence answers', async () => {
    const answer = heldWrites()
    const { result } = renderPane()
    let stopped: Promise<unknown> = Promise.resolve('unset')
    act(() => {
      stopped = result.current.cancel('turn-1')
    })
    await act(async () => {
      answer({ ok: true, replayed: false, fence: 3, value: { cancelled: true } })
      await stopped
    })
    expect(await stopped).toEqual({ cancelled: true })
  })
})
