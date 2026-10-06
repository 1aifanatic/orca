// The delivery notice and the outbox queue behind it: a send with no answer reads as sending and
// goes again under its id, and a send the host holds a row for leaves, so nothing waits on it.

// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle, useRef } from 'react'
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
            ? projectStructuredAgentSessionMessages([], outbox.outbox, [], {
                rejectedInPlace: true
              })
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

vi.mock('./use-native-chat-font-size', () => ({
  useNativeChatFontSize: () => undefined
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
import {
  advanceProbeClock,
  seededEntry,
  seedOutbox,
  useProbeClock
} from './NativeChatStructuredSession.test-harness'

describe('NativeChatStructuredSession delivery', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
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

  // Resent under its own id until the host answers, so its row says only that it is still sending.
  it('says a send whose answer was lost is sending until it confirms on its own, with no Retry', async () => {
    useProbeClock()
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
    await act(async () => {
      expect(send?.('hello', [])).toBe(true)
    })
    // From the moment it is sent, through the lost answer, until the host confirms it.
    expect(getStructuredAgentSessionOutbox('session-1')).toMatchObject([{ state: 'unconfirmed' }])
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()

    await advanceProbeClock(1000)
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call.mock.calls[1]?.[2]).toEqual(mocks.call.mock.calls[0]?.[2])
    expect(screen.queryByText('Sending…')).toBeNull()
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
    useProbeClock()
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
    await advanceProbeClock(1000)
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
      envelope: { clientOperationId: 'op-sent' }
    })
    expect(getStructuredAgentSessionOutbox('session-reopened')).toEqual([])
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
      useProbeClock()
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

      await advanceProbeClock(0)
      expect(getStructuredAgentSessionOutbox(sessionId)).toEqual([])
      expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
      expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
      await advanceProbeClock(1500)
      expect(mocks.call).not.toHaveBeenCalled()
    },
    10000
  )

  it('never sends a send an older build said a Stop outlived, and offers no Retry', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.submissions = []
    seedMidSend('session-reopened-stopped', { outlivedStop: true })

    renderSession('session-reopened-stopped')

    // Its settlement waits for the journal, and it is not being sent, so nothing reads "Sending…".
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    await advanceProbeClock(1500)
    expect(mocks.call).not.toHaveBeenCalled()
  }, 10000)
})
