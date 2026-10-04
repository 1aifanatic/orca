// The delivery notice and the outbox queue behind it: a send with no answer reads as sending and
// goes again under its id, and a send the host holds a row for leaves, so nothing waits on it.

// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import type { NativeChatQuestionCardProps } from './NativeChatQuestionCard'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  fileLinkClick: vi.fn(),
  mode: 'static' as 'static' | 'outbox',
  messageListProps: null as null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
    runtimeContext?: unknown
  },
  composerProps: null as null | {
    structuredTransport?: Record<string, unknown>
    isWorking?: boolean
  },
  questionCardProps: null as NativeChatQuestionCardProps | null,
  promptItems: [] as AgentJournalRenderItem[],
  respond: vi.fn(),
  handlePasteEvent: vi.fn(),
  pasteFromClipboard: vi.fn(),
  submissions: [] as unknown[],
  monitoringBackgroundTasks: false,
  supportsBackgroundTaskStop: false,
  supportsBackgroundTaskStopAll: true,
  backgroundTasks: [] as AgentSessionBackgroundTask[],
  stopBackgroundTask: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  // The pane activates the host status feed for its startup phase; nothing here drives it.
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))

vi.mock('./use-structured-agent-session', async () => {
  const { useStructuredAgentSessionOutbox } = await import('./use-structured-agent-session-outbox')
  const { projectStructuredAgentSessionMessages } =
    await import('../../../../shared/structured-agent-session-message-projection')
  return {
    useStructuredAgentSession: (props: {
      sessionId: string
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
    }) => {
      const outbox = useStructuredAgentSessionOutbox({
        sessionId: props.sessionId,
        target: props.target,
        fence: 1,
        submissions: mocks.submissions as never
      })
      return {
        journalItems: [],
        messages:
          mocks.mode === 'outbox'
            ? projectStructuredAgentSessionMessages([], outbox.outbox, [])
            : [
                {
                  id: 'message-1',
                  role: 'assistant',
                  source: 'transcript',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: '[file](file:///repo/src/main.ts)' }]
                }
              ],
        status: 'ready' as const,
        error: outbox.error,
        hasOlder: false,
        loadingOlder: false,
        loadOlder: vi.fn(),
        prompts: mocks.promptItems,
        outbox: outbox.outbox,
        submissions: mocks.submissions,
        send: outbox.send,
        isWorking: false,
        isMonitoringBackgroundTasks: mocks.monitoringBackgroundTasks,
        supportsBackgroundTaskStop: mocks.supportsBackgroundTaskStop,
        supportsBackgroundTaskStopAll: mocks.supportsBackgroundTaskStopAll,
        backgroundTasks: mocks.backgroundTasks,
        turnId: null,
        cancel: vi.fn(),
        queuedMessages: {
          cards: [],
          steer: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          edit: vi.fn(async () => {}),
          steerNewest: () => false
        },
        stopBackgroundTask: (taskId?: string) => mocks.stopBackgroundTask(props.sessionId, taskId),
        respond: mocks.respond,
        optionSnapshot: [
          {
            id: 'model',
            label: 'Model',
            category: 'model',
            kind: {
              type: 'select',
              currentValue: 'gpt-live',
              choices: [{ value: 'gpt-live', label: 'GPT Live' }]
            },
            valueSource: 'reported',
            settable: true
          }
        ],
        optionSurface: {
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        setStructuredOption: vi.fn()
      }
    }
  }
})

vi.mock('./use-native-chat-font-scale', () => ({
  useNativeChatFontScale: () => ({ scale: 1 })
}))

vi.mock('./use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: () => ({
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    runtimeEnvironmentId: null
  })
}))

vi.mock('./use-native-chat-file-link-click', () => ({
  useNativeChatFileLinkClick: (context: unknown) => (context ? mocks.fileLinkClick : undefined)
}))

vi.mock('./NativeChatMessageList', async () => {
  const { DeliveryNoticesMock } = await import('./NativeChatStructuredSession.test-harness')
  return {
    NativeChatMessageList: (
      props: NonNullable<typeof mocks.messageListProps> & {
        deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
      }
    ) => {
      mocks.messageListProps = props
      return <DeliveryNoticesMock notices={props.deliveryNotices} />
    }
  }
})

vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: forwardRef((props: typeof mocks.composerProps, ref) => {
    mocks.composerProps = props
    const fieldRef = useRef<HTMLTextAreaElement>(null)
    useImperativeHandle(ref, () => ({
      // Match the real composer so focus ownership is observable in this split suite.
      focus: () => {
        fieldRef.current?.focus()
        return true
      },
      insertTypedText: () => true,
      handlePasteEvent: mocks.handlePasteEvent,
      pasteFromClipboard: mocks.pasteFromClipboard,
      contains: (node: Node | null) => fieldRef.current?.contains(node) === true
    }))
    return <textarea ref={fieldRef} data-testid="structured-composer" />
  })
}))
vi.mock('./NativeChatEmptyState', () => ({ NativeChatEmptyState: () => null }))
vi.mock('./NativeChatApprovalCard', () => ({ NativeChatApprovalCard: () => null }))
vi.mock('./NativeChatQuestionCard', () => ({
  NativeChatQuestionCard: (props: NativeChatQuestionCardProps) => {
    mocks.questionCardProps = props
    return null
  }
}))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { getStructuredAgentSessionOutbox } from './structured-agent-session-outbox-storage'

describe('NativeChatStructuredSession delivery', () => {
  afterEach(() => {
    cleanup()
    mocks.call.mockReset()
    mocks.mode = 'static'
    mocks.messageListProps = null
    mocks.composerProps = null
    mocks.questionCardProps = null
    mocks.promptItems = []
    mocks.respond.mockReset()
    mocks.handlePasteEvent.mockReset()
    mocks.pasteFromClipboard.mockReset()
    mocks.submissions = []
    mocks.monitoringBackgroundTasks = false
    mocks.supportsBackgroundTaskStop = false
    mocks.supportsBackgroundTaskStopAll = true
    mocks.stopBackgroundTask.mockReset()
    mocks.backgroundTasks = []
  })

  function seededEntry(
    sessionId: string,
    clientMessageId: string,
    text: string,
    state: 'queued' | 'unconfirmed'
  ) {
    return {
      clientMessageId,
      sessionId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      previewUris: [],
      state,
      queuedAt: clientMessageId === 'op-head' ? 1 : 2,
      lastAttemptAt: null
    }
  }

  function seedOutbox(sessionId: string, entries: unknown[]): void {
    localStorage.setItem(
      `orca:desktopStructuredAgentSessionOutbox:v1:${encodeURIComponent(sessionId)}`,
      JSON.stringify(entries)
    )
  }

  // Resent under its own id until the host answers, so its row says only that it is still sending.
  it('says a send whose answer was lost is sending until it confirms on its own, with no Retry', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValueOnce({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('hello', [])).toBe(true)
    // From the moment it is sent, through the lost answer, until the host confirms it.
    await waitFor(() => expect(screen.getByText('Sending…')).toBeTruthy())
    await waitFor(() =>
      expect(getStructuredAgentSessionOutbox('session-1')).toMatchObject([{ state: 'unconfirmed' }])
    )
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 5000 })
    expect(mocks.call.mock.calls[1]?.[2]).toEqual(mocks.call.mock.calls[0]?.[2])
    await waitFor(() => expect(screen.queryByText('Sending…')).toBeNull())
    expect(getStructuredAgentSessionOutbox('session-1')).toEqual([])
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
  }, 10000)

  // Reopened mid-send, the send is read back in doubt; the probe resends it under its own id.
  function seedMidSend(sessionId: string, patch: Record<string, unknown> = {}): void {
    seedOutbox(sessionId, [
      {
        ...seededEntry(sessionId, 'op-sent', 'first', 'queued'),
        state: 'dispatching',
        lastAttemptAt: 1,
        ...patch
      }
    ])
  }

  function renderSession(sessionId: string): void {
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId={`structured-tab-${sessionId}`}
        sessionId={sessionId}
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
  }

  it('says a send reopened mid-send is sending while it is resent, until it settles', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'op-sent', dispatchState: 'accepted' } }
    })
    seedMidSend('session-reopened')

    renderSession('session-reopened')

    expect(getStructuredAgentSessionOutbox('session-reopened')).toMatchObject([
      { clientMessageId: 'op-sent', state: 'unconfirmed' }
    ])
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce(), { timeout: 3000 })
    expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
      envelope: { clientOperationId: 'op-sent' }
    })
    await waitFor(() => expect(getStructuredAgentSessionOutbox('session-reopened')).toEqual([]))
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
  }, 10000)

  // The host has a record of it, so the row shows it from there: the entry leaves, and nothing
  // waits on a Retry that no longer exists.
  it.each([
    ['a live unknown', {}],
    ['a recovered unknown', { recovered: true }],
    ["an older host's recovered unknown", { reason: 'host_restarted_before_acknowledgement' }]
  ])(
    'lets a send reopened mid-send leave once the journal holds %s, with no Retry and no resend',
    async (label, patch) => {
      mocks.mode = 'outbox'
      const sessionId = `session-reopened-${label.replace(/\W+/g, '-')}`
      mocks.submissions = [
        {
          clientMessageId: 'op-sent',
          fence: 1,
          payloadFingerprint: 'fp',
          dispatchState: 'unknown',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null,
          ...patch
        }
      ]
      seedMidSend(sessionId)

      renderSession(sessionId)

      await waitFor(() => expect(getStructuredAgentSessionOutbox(sessionId)).toEqual([]))
      expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
      expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500))
      })
      expect(mocks.call).not.toHaveBeenCalled()
    },
    10000
  )

  it('never sends a send an older build said a Stop outlived, and offers no Retry', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    seedMidSend('session-reopened-stopped', { outlivedStop: true })

    renderSession('session-reopened-stopped')

    // Its settlement waits for the journal; until then it reads as not confirmed yet.
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    })
    expect(mocks.call).not.toHaveBeenCalled()
  }, 10000)

  it('resends a transport-unconfirmed head so later messages are not wedged', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-wedge"
        sessionId="session-wedge"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    expect(send?.('second', [])).toBe(true)
    // The head is probed automatically, clears, and the queue drains.
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3), { timeout: 10000 })
    await waitFor(() => expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull())
  }, 20000)

  it('probes the same operation without marking an explicit user retry', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-probe-flag"
        sessionId="session-probe-flag"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 10000 })

    const first = mocks.call.mock.calls[0]?.[2] as Record<string, unknown>
    const probe = mocks.call.mock.calls[1]?.[2] as Record<string, unknown>
    expect(probe.retryUnknown).toBeUndefined()
    // Same operation id: both dedupe layers key off it.
    expect((probe.envelope as { clientOperationId: string }).clientOperationId).toBe(
      (first.envelope as { clientOperationId: string }).clientOperationId
    )
  }, 20000)

  it('lets a head the host answers in doubt leave, so the message behind it goes out (no parked head)', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-parked"
        sessionId="session-parked"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    const sent = mocks.call.mock.calls[0]?.[2] as { envelope: { clientOperationId: string } }
    // The host now reports the row in doubt: it has a record, so the row shows it from here.
    mocks.submissions = [
      {
        clientMessageId: sent.envelope.clientOperationId,
        fence: 1,
        payloadFingerprint: 'fp',
        dispatchState: 'unknown',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    ]
    // A later send, with no user action: it goes out instead of waiting behind the head.
    await act(async () => {
      send?.('second', [])
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 5000 })
    const texts = mocks.call.mock.calls.map(
      (call) => (call[2] as { body: { blocks: { text: string }[] } }).body.blocks[0]?.text
    )
    expect(texts).toEqual(['first', 'second'])
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  }, 20000)

  it('still probes while streaming batches rebuild the submissions array', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    const makeView = (): React.ReactElement => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-churn"
        sessionId="session-churn"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const { rerender } = render(makeView())

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    // Each batch mints a fresh submissions array for an unrelated message. An
    // array-identity dependency restarts the backoff on every one of these, so a
    // stream that outlasts the delay would never let the probe fire.
    for (let index = 0; index < 12; index += 1) {
      mocks.submissions = [
        {
          clientMessageId: `other-${index}`,
          fence: 1,
          payloadFingerprint: 'fp',
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: index,
          resolvedAt: index
        }
      ]
      await act(async () => {
        rerender(makeView())
        await new Promise((resolve) => setTimeout(resolve, 250))
      })
    }

    // Asserted with no trailing grace period: the probe must have fired *during*
    // the stream, not after it went quiet.
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 20000)

  it('restarts probe delay when the runtime target changes', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    const makeView = (
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
    ) => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-target-switch"
        sessionId="session-target-switch"
        target={target}
        agent="codex"
      />
    )
    const { rerender } = render(makeView({ kind: 'local' }))
    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    rerender(makeView({ kind: 'environment', environmentId: 'env-1' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(mocks.call).toHaveBeenCalledOnce()
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 1500 })
  }, 10000)

  it('does not hot-loop when the host answers pending', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'pending' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-pending"
        sessionId="session-pending"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    // A pending row parks the entry under the backoff instead of re-dispatching
    // immediately. Without that, this window is an unbounded back-to-back RPC flood.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
    })
    expect(mocks.call.mock.calls.length).toBeLessThanOrEqual(3)
  }, 20000)

  it('keeps probing past the old five-attempt budget', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValue(new Error('socket closed'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(
        <NativeChatStructuredSession
          isVisible
          isFocusedGroup
          tabId="structured-tab-budget"
          sessionId="session-budget"
          target={{ kind: 'local' }}
          agent="codex"
        />
      )

      const send = mocks.composerProps?.structuredTransport?.send as
        | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
        | undefined
      expect(send?.('first', [])).toBe(true)

      // Backoff is 1+2+4+8+16 = 31s for five probes, which was the old hard budget.
      // Step past it; a seventh call proves the probe re-arms instead of giving up.
      for (let step = 0; step < 12; step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(8_000)
        })
      }
      expect(mocks.call.mock.calls.length).toBeGreaterThanOrEqual(7)
    } finally {
      vi.useRealTimers()
    }
  }, 30000)
})
