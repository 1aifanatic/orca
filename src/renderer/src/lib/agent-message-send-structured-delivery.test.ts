// @vitest-environment happy-dom
// Notes or annotations sent to an existing chat at rest: its agent starts on that message, which
// may fail. The source clears what it sent only once the agent took it, and a message not taken
// stays in the chat without a Retry there, since the source still holds it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import {
  reconcileStructuredAgentSessionOutbox,
  stageStructuredAgentSessionOutboxEntryForSend
} from '../../../shared/structured-agent-session-outbox'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  mutateStructuredAgentSessionLaunchPrompt
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { structuredAgentSessionDeliveryNotices } from '@/components/native-chat/structured-agent-session-delivery-notices'
import type { AppState } from '@/store/types'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import { sendMessageToAgent } from './agent-message-send'
import {
  FIRST_START_FAILS,
  firstMessageStream,
  play,
  type FirstMessageStream
} from './structured-agent-session-launch-prompt-test-support'

const client = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: client.call,
  subscribeStructuredAgentSession: client.subscribe
}))

vi.mock('./structured-agent-session-launch', () => ({
  relaunchFailedStructuredAgentSessionForMessage: vi.fn()
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

const WORKTREE = 'wt-1'
let session = 0
let sessionId = ''

/** The one message the code under test queued on the chat. */
function sentEntry() {
  const [entry] = getStructuredAgentSessionOutbox(sessionId)
  return entry
}

/** The open chat's drain putting the queued message on the wire, as it does for any send. */
function chatSendsIt(): void {
  mutateStructuredAgentSessionLaunchPrompt(sessionId, sentEntry().clientMessageId, (entry) =>
    stageStructuredAgentSessionOutboxEntryForSend(entry, Date.now())
  )
}

/** The open chat folding the journal's answer into its outbox. */
function chatReconciles(submission: AgentJournalSubmission): void {
  commitStructuredAgentSessionOutbox(
    sessionId,
    reconcileStructuredAgentSessionOutbox(getStructuredAgentSessionOutbox(sessionId), [submission])
  )
}

function rejectedSubmission(): AgentJournalSubmission {
  return {
    clientMessageId: sentEntry().clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: "Claude isn't installed.",
    rejection: { kind: 'providerMissing' },
    submittedAt: 1,
    resolvedAt: 2
  }
}

function settledState<T>(promise: Promise<T>): () => T | 'unsettled' {
  let state: T | 'unsettled' = 'unsettled'
  void promise.then((value) => {
    state = value
  })
  return () => state
}

async function sendNotes(): Promise<{
  result: Promise<Awaited<ReturnType<typeof sendMessageToAgent>>>
  stream: FirstMessageStream
}> {
  const opened = firstMessageStream(client, () => sentEntry().clientMessageId)
  const result = sendMessageToAgent({
    worktreeId: WORKTREE,
    prompt: 'Review these notes',
    target: { kind: 'structured-session', sessionId }
  })
  const stream = await opened
  chatSendsIt()
  return { result, stream }
}

beforeEach(() => {
  session += 1
  sessionId = `claude-${session}`
  client.call.mockReset()
  client.subscribe.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
})

afterEach(() => {
  localStorage.clear()
})

describe('notes sent to a chat whose agent starts on them', () => {
  it('count as sent only once a retried start takes them', async () => {
    const { result, stream } = await sendNotes()
    const sent = settledState(result)

    play(stream, FIRST_START_FAILS.retriedThenTaken.slice(0, -1))
    await Promise.resolve()
    expect(sent()).toBe('unsettled')

    play(stream, FIRST_START_FAILS.retriedThenTaken.slice(-1))
    await expect(result).resolves.toEqual({ status: 'sent' })
    expect(stream.open()).toBe(false)
  })

  it('wait through a lost answer that a late echo proves taken', async () => {
    const { result, stream } = await sendNotes()
    play(stream, FIRST_START_FAILS.unknownThenTaken)
    await expect(result).resolves.toEqual({ status: 'sent' })
  })

  it.each([
    ['rejected after its tries', FIRST_START_FAILS.rejectedAfterTries],
    ['withdrawn when the chat closes mid-wait', FIRST_START_FAILS.chatClosed]
  ])('are not sent when %s, and stay in the chat as its source', async (_case, changes) => {
    const { result, stream } = await sendNotes()
    play(stream, changes)

    await expect(result).resolves.toEqual({
      status: 'not-taken',
      code: 'session-message-not-taken'
    })
    expect(sentEntry()).toMatchObject({ source: 'surface' })
  })

  it('leave the chat no Retry once rejected, and say where to send them again', async () => {
    const { result } = await sendNotes()
    chatReconciles(rejectedSubmission())

    await expect(result).resolves.toMatchObject({ status: 'not-taken' })
    const notice = structuredAgentSessionDeliveryNotices(
      getStructuredAgentSessionOutbox(sessionId),
      'Claude',
      vi.fn(),
      [rejectedSubmission()],
      [],
      new Set()
    ).get(agentJournalSubmissionKey(sentEntry().clientMessageId))
    expect(notice?.onRetry).toBeUndefined()
    expect(notice?.text).toBe(
      "Not sent: Claude isn't installed. Install it first. Send it again from where you started it."
    )
  })

  it('are not sent when the host refuses the send before recording it', async () => {
    const { result } = await sendNotes()
    mutateStructuredAgentSessionLaunchPrompt(sessionId, sentEntry().clientMessageId, (entry) => ({
      ...entry,
      state: 'queued',
      lastFailure: { kind: 'refused', code: 'agent_session_operation_capacity' }
    }))

    await expect(result).resolves.toMatchObject({ status: 'not-taken' })
  })
})

// The picker lists a chat once it has a status row; its agent may since have stopped, and starts
// again on the next message the same way.
describe('annotations sent from the agent picker to a chat whose agent starts on them', () => {
  const chatTabId = 'tab-chat'

  function pickerStore(): StoreApi<AppState> {
    const store = createUIStore()
    const now = Date.now()
    const paneKey = structuredAgentSessionPaneKey(chatTabId, sessionId)
    store.setState({
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'done',
          prompt: 'previous',
          updatedAt: now,
          stateStartedAt: now,
          agentType: 'claude',
          paneKey,
          stateHistory: []
        }
      },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      unifiedTabsByWorktree: {
        [WORKTREE]: [
          {
            id: chatTabId,
            entityId: sessionId,
            groupId: 'group-1',
            worktreeId: WORKTREE,
            contentType: 'agent-session',
            agentSessionAgent: 'claude',
            label: 'Claude Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: Date.now()
          }
        ]
      }
    })
    return store
  }

  async function sendFromPicker(onPromptDelivered: () => void) {
    const store = pickerStore()
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId: WORKTREE,
      source: 'browser-annotations',
      prompt: 'Fix these annotations',
      label: 'Browser annotations',
      launchSource: 'notes_send',
      onPromptDelivered
    })
    const opened = firstMessageStream(client, () => sentEntry().clientMessageId)
    const sent = store
      .getState()
      .sendPromptToSidebarAgentTarget(structuredAgentSessionPaneKey(chatTabId, sessionId))
    return { sent, stream: await opened }
  }

  it('are cleared once, after the retried start takes them', async () => {
    const onPromptDelivered = vi.fn()
    const { sent, stream } = await sendFromPicker(onPromptDelivered)

    play(stream, FIRST_START_FAILS.retriedThenTaken.slice(0, -1))
    await Promise.resolve()
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()

    play(stream, FIRST_START_FAILS.retriedThenTaken.slice(-1))
    await expect(sent).resolves.toBe(true)
    expect(onPromptDelivered).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('Sent to Claude')
  })

  it.each([
    ['rejected after its tries', FIRST_START_FAILS.rejectedAfterTries],
    ['withdrawn when the chat closes mid-wait', FIRST_START_FAILS.chatClosed]
  ])('are kept, with a failure notice, when %s', async (_case, changes) => {
    const onPromptDelivered = vi.fn()
    const { sent, stream } = await sendFromPicker(onPromptDelivered)
    play(stream, changes)

    await expect(sent).resolves.toBe(false)
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith("Couldn't send to Claude", {
      description:
        'The selected agent did not take the notes; its chat says why. (session-message-not-taken)'
    })
  })
})
