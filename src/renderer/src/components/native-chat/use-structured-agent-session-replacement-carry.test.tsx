// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ call: vi.fn(), outline: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  readStructuredAgentSessionConversationOutline: mocks.outline
}))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey as scope } from './native-chat-composer-draft-store'
import { useStructuredAgentSessionReplacementCarry } from './use-structured-agent-session-replacement-carry'
import {
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage
} from './structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import { getStructuredAgentSessionSendNotice } from './structured-agent-session-pending-sends'

const target = { kind: 'local' } as const
const NO_ROWS: readonly AgentJournalSubmission[] = []
const NO_CARDS: readonly string[] = []

function pane(replacesSessionId: string | undefined = 'old', cards: readonly string[] = NO_CARDS) {
  return renderHook(() =>
    useStructuredAgentSessionReplacementCarry({
      sessionId: 'new',
      replacesSessionId,
      composerScopeKey: scope('new'),
      target,
      fence: 1,
      submissions: NO_ROWS,
      queuedMessageIds: cards
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionSendsForTests()
  noteStructuredAgentSessionFence('old', 1)
  mocks.outline.mockResolvedValue({ entries: [], omittedEntries: 0 })
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionSendsForTests()
})

describe('a cleared chat follows its replacement without another send', () => {
  it('appends the old draft once to a new pane, preserving its current text', () => {
    writeNativeChatDraftCache(scope('old'), 'old draft')
    writeNativeChatDraftCache(scope('new'), 'new draft')
    const { rerender } = pane()
    expect(readNativeChatDraftCache(scope('new'))).toBe('new draft\n\nold draft')
    expect(readNativeChatDraftCache(scope('old'))).toBe('')
    rerender()
    expect(readNativeChatDraftCache(scope('new'))).toBe('new draft\n\nold draft')
  })

  it.each(['/clear', '/compact'])('does not carry the lone %s command', (command) => {
    writeNativeChatDraftCache(scope('old'), command)
    pane()
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    expect(readNativeChatDraftCache(scope('old'))).toBe('')
  })

  it('keeps a reopened old chat independent while its tab is shown', () => {
    const { rerender } = renderHook(
      ({ link }: { link: string | undefined }) =>
        useStructuredAgentSessionReplacementCarry({
          sessionId: 'new',
          replacesSessionId: link,
          composerScopeKey: scope('new'),
          target,
          fence: 1,
          submissions: NO_ROWS,
          queuedMessageIds: NO_CARDS
        }),
      { initialProps: { link: undefined } }
    )
    act(() => writeNativeChatDraftCache(scope('old'), 'typed in history'))
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    rerender({ link: 'old' })
    expect(readNativeChatDraftCache(scope('new'))).toBe('typed in history')
  })

  it('shows a pending send once, then carries the refused text and its reason to the new composer', async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.call.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const sent = sendStructuredAgentSessionMessage({
      sessionId: 'old',
      target,
      text: 'racing send',
      delivery: 'queue-if-active'
    })
    const { result } = pane()
    expect(result.current.map((entry) => entry.clientMessageId)).toEqual([sent?.clientMessageId])
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await act(async () => {
      answer({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: 'conversationCleared' },
          message: 'cleared'
        }
      })
      await sent?.outcome
    })
    expect(result.current).toEqual([])
    expect(readNativeChatDraftCache(scope('new'))).toBe('racing send')
    expect(readNativeChatDraftCache(scope('old'))).toBe('')
    expect(getStructuredAgentSessionSendNotice('new')).toBe(
      "The chat was cleared before your message went out. It's back in the composer."
    )
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('an accepted pending send disappears without returning its text', async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.call.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const sent = sendStructuredAgentSessionMessage({ sessionId: 'old', target, text: 'accepted' })
    const { result } = pane()
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await act(async () => {
      answer({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'e', sequence: 1 },
        value: {
          clientMessageId: sent?.clientMessageId,
          queued: { messageId: sent?.clientMessageId, position: 1, state: 'waiting' }
        }
      })
      await sent?.outcome
    })
    expect(result.current).toEqual([])
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('a lost answer returns unconfirmed text without sending it again', async () => {
    let reject: (error: Error) => void = () => {}
    mocks.call.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const sent = sendStructuredAgentSessionMessage({ sessionId: 'old', target, text: 'lost reply' })
    pane()
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await act(async () => {
      reject(new Error('connection lost'))
      await sent?.outcome
    })
    expect(readNativeChatDraftCache(scope('new'))).toBe('lost reply')
    expect(getStructuredAgentSessionSendNotice('new')).toContain("couldn't confirm")
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('a card carried by the host settles the old pending request without a hand-back', async () => {
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const sent = sendStructuredAgentSessionMessage({
      sessionId: 'old',
      target,
      text: 'carried by host'
    })
    if (!sent) throw new Error('send refused')
    const { result } = pane('old', [sent.clientMessageId])
    expect(await sent.outcome).toBe('recorded')
    expect(result.current).toEqual([])
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
  })

  it('recovers a legacy copy using the existing outline reader and never resends it', async () => {
    localStorage.setItem(
      'orca:desktopStructuredAgentSessionOutbox:v1:old',
      JSON.stringify([
        {
          clientMessageId: 'legacy',
          queuedAt: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'legacy text' }] }
        }
      ])
    )
    pane()
    await waitFor(() => expect(readNativeChatDraftCache(scope('new'))).toBe('legacy text'))
    expect(mocks.outline).toHaveBeenCalledWith(target, 'old')
    expect(mocks.call).not.toHaveBeenCalled()
    expect(localStorage.getItem('orca:desktopStructuredAgentSessionOutbox:v1:old')).toBeNull()
  })
})
