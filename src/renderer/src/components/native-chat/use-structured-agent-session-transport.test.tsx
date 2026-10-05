// Why the transport reads at all.
//
// A worktree switch hides the chat pane, but a message the user already sent is still owed a
// delivery. The read is what carries the journal rows that retire it, and its subscription is
// what keeps the host from evicting the session out from under it -- so undelivered work holds
// the read open on its own, without the user looking at the pane.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn().mockResolvedValue(false),
  supportsStructuredAgentSessionPromptCancel: vi.fn().mockResolvedValue(false)
}))

import { useStructuredAgentSessionTransport } from './use-structured-agent-session-transport'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'
import {
  resetUndeliveredStructuredAgentSessionOutboxForTests,
  writeOutbox
} from './structured-agent-session-outbox-storage'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

const LOCAL_TARGET = { kind: 'local' } as const

function emptyPage(): AgentSessionHistoryPage {
  const cursor = (sequence: number): AgentJournalCursor => ({ epoch: 'epoch-a', sequence })
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: cursor(0) },
    liveCursor: cursor(0),
    hasOlder: false,
    hasNewer: false
  }
}

function undeliveredEntry(sessionId: string) {
  return createStructuredAgentSessionOutboxEntry({
    clientMessageId: 'client-queued',
    sessionId,
    text: 'still undelivered',
    attachments: [],
    queuedAt: 1
  })
}

function renderHiddenTransport(sessionId: string, enabled = true) {
  return renderHook(() =>
    useStructuredAgentSessionTransport({
      sessionId,
      target: LOCAL_TARGET,
      isVisible: false,
      enabled
    })
  )
}

describe('useStructuredAgentSessionTransport', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
    resetUndeliveredStructuredAgentSessionOutboxForTests()
    localStorage.clear()
    mocks.call.mockResolvedValue({ ok: true, page: emptyPage() })
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  })

  it('reads, writes, and releases a paired chat through its owning runtime', async () => {
    const target = { kind: 'environment', environmentId: 'server-1' } as const
    const unsubscribe = vi.fn()
    mocks.subscribe.mockResolvedValue({ unsubscribe })
    mocks.call.mockImplementation(async (_target, method: string) => {
      if (method === 'agentSession.history') {
        return { ok: true, page: { ...emptyPage(), fence: 3 } }
      }
      return {
        ok: true,
        value: method === 'agentSession.send' ? { queued: {} } : { applied: true }
      }
    })
    const { result, unmount } = renderHook(() => {
      const transport = useStructuredAgentSessionTransport({
        sessionId: 'session-a',
        target,
        isVisible: true,
        enabled: true
      })
      const outbox = useStructuredAgentSessionOutbox({
        sessionId: 'session-a',
        target,
        fence: transport.state.fence,
        submissions: transport.state.submissions,
        journalItems: transport.state.items
      })
      return { transport, outbox }
    })
    await waitFor(() => expect(result.current.transport.state.fence).toBe(3))

    act(() => {
      result.current.outbox.send('hello')
    })
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        target,
        'agentSession.send',
        expect.objectContaining({
          envelope: expect.objectContaining({ sessionId: 'session-a', expectedRuntimeFence: 3 })
        })
      )
    )

    const actions = [
      ['agentSession.cancel', 'agentSession.cancel', { turnId: 'turn-1' }],
      [
        'agentSession.respondToApproval',
        'agentSession.respondTo:approval',
        { itemId: 'approval-1', expectedRevision: 1, optionId: 'allow' }
      ],
      [
        'agentSession.respondToQuestion',
        'agentSession.respondTo:question',
        { itemId: 'question-1', expectedRevision: 1, optionId: 'yes' }
      ]
    ] as const
    for (const [method, fingerprintMethod, fields] of actions) {
      await act(async () => {
        expect(await result.current.transport.mutate(method, fingerprintMethod, fields)).toEqual({
          applied: true
        })
      })
      expect(mocks.call).toHaveBeenLastCalledWith(target, method, {
        envelope: expect.objectContaining({ sessionId: 'session-a', expectedRuntimeFence: 3 }),
        ...fields
      })
    }

    unmount()
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.release', expect.anything())
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.subscribe).toHaveBeenCalledWith(
      target,
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    )
    expect(mocks.call.mock.calls.every(([owner]) => owner === target)).toBe(true)
  })

  it('keeps reading a hidden session that still owes a delivery', async () => {
    writeOutbox('session-undelivered', [undeliveredEntry('session-undelivered')])

    const view = renderHiddenTransport('session-undelivered')

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
    view.unmount()
  })

  it('stops reading a hidden session once its outbox drains', async () => {
    const unsubscribe = vi.fn()
    mocks.subscribe.mockResolvedValue({ unsubscribe })
    writeOutbox('session-drained', [undeliveredEntry('session-drained')])

    const view = renderHiddenTransport('session-drained')
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))

    act(() => {
      writeOutbox('session-drained', [])
    })

    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
    view.unmount()
  })

  it('leaves a hidden session with nothing owed unread', async () => {
    const view = renderHiddenTransport('session-idle')

    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.subscribe).not.toHaveBeenCalled()
    view.unmount()
  })

  it('does not read an unpublished session holding a staged launch prompt', async () => {
    writeOutbox('session-provisional', [undeliveredEntry('session-provisional')])

    const view = renderHiddenTransport('session-provisional', false)

    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.subscribe).not.toHaveBeenCalled()
    view.unmount()
  })
})
