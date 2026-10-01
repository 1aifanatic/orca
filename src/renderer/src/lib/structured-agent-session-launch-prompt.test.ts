// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  mutateStructuredAgentSessionLaunchPrompt
} from '@/components/native-chat/structured-agent-session-outbox-storage'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { settleStructuredAgentLaunchPrompt } from './structured-agent-session-launch-prompt'

const PENDING = {
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'pending' as const,
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null
}

/** The host's answer at acceptance; a host that predates the hand-over record omits it. */
function sendAnswer(clientMessageId: string, handoverRecorded = true) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        ...PENDING,
        ...(handoverRecorded ? { handoverRecorded: true as const } : {})
      }
    }
  }
}

function frame(
  type: 'snapshot' | 'batch',
  submission: AgentJournalSubmission
): AgentSessionSubscribeEvent {
  const cursor = { epoch: 'epoch-1', sequence: 2 }
  return type === 'batch'
    ? {
        type,
        sessionId: 'session-1',
        batch: { cursor, items: [], removedItemIds: [], submissions: [submission] }
      }
    : {
        type,
        sessionId: 'session-1',
        fence: 2,
        page: {
          sessionId: 'session-1',
          epoch: 'epoch-1',
          direction: 'tail',
          items: [],
          removedItemIds: [],
          submissions: [submission],
          window: { oldest: null, newest: null, nextCursor: cursor },
          hasOlder: false,
          hasNewer: false
        }
      }
}

/** The session's publication after the send, frame by frame, as the host would stream it. */
function publishes(...events: AgentSessionSubscribeEvent[]): void {
  mocks.subscribe.mockImplementation(async (_target, _params, onEvent) => {
    queueMicrotask(() => events.forEach((event) => onEvent(event)))
    return { unsubscribe: mocks.unsubscribe }
  })
}

describe('settleStructuredAgentLaunchPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('reports a launch prompt delivered once the host hands it over, retaining it for the provider echo', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    const onPromptDelivered = vi.fn()
    const clientMessageId = stagedEntry!.clientMessageId
    mocks.call.mockResolvedValue(sendAnswer(clientMessageId))
    publishes(
      frame('snapshot', { clientMessageId, ...PENDING, handoverRecorded: true }),
      frame('batch', {
        clientMessageId,
        ...PENDING,
        handoverRecorded: true as const,
        handedOverAt: 5
      })
    )

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        options: { prompt: 'review this', onPromptDelivered },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })

    expect(onPromptDelivered).toHaveBeenCalledOnce()
    const persisted = JSON.parse(localStorage.getItem(localStorage.key(0)!) ?? '[]') as {
      state: string
    }[]
    expect(persisted).toMatchObject([{ state: 'dispatching' }])
  })

  it('drops the previous attempt failure when the launch path sends the message again', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    mutateStructuredAgentSessionLaunchPrompt(
      'session-1',
      stagedEntry!.clientMessageId,
      (entry) => ({
        ...entry,
        lastFailure: { kind: 'refused', code: 'agent_session_operation_capacity' }
      })
    )
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })

    await settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      options: { prompt: 'review this' },
      stagedEntry
    })

    const persisted: unknown = JSON.parse(localStorage.getItem(localStorage.key(0)!) ?? '[]')
    expect(persisted).toHaveLength(1)
    expect(persisted).not.toContainEqual(
      expect.objectContaining({ lastFailure: expect.anything() })
    )
  })

  // Whatever the start's failure (signed out, not installed, the agent exiting as it started), it
  // ends as the message's rejection; nothing that writes on delivery may run.
  it.each(['notSignedIn', 'providerMissing', 'providerExited'])(
    'reports a launch prompt whose start failed (%s) undelivered, after a retried start',
    async (kind) => {
      const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
      const onPromptDelivered = vi.fn()
      const clientMessageId = stagedEntry!.clientMessageId
      mocks.call.mockResolvedValue(sendAnswer(clientMessageId))
      const queued = { clientMessageId, ...PENDING, handoverRecorded: true as const }
      publishes(
        frame('snapshot', queued),
        frame('batch', {
          ...queued,
          startFailure: {
            attempts: 1,
            reason: 'An account switch is in progress.',
            rejection: { kind: 'accountSwitchInProgress' },
            failedAt: 2,
            nextAttemptAt: 15_002
          }
        }),
        frame('batch', { ...queued, dispatchState: 'rejected', rejection: { kind } })
      )

      await expect(
        settleStructuredAgentLaunchPrompt({
          launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
          options: { prompt: 'review this', onPromptDelivered },
          stagedEntry
        })
      ).resolves.toEqual({ delivered: false, failureNotified: false })
      expect(onPromptDelivered).not.toHaveBeenCalled()
      expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    }
  )

  it('counts a pending answer from a host that predates the hand-over record as handed over', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    mocks.call.mockResolvedValue(sendAnswer(stagedEntry!.clientMessageId, false))

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        options: { prompt: 'review this' },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(mocks.subscribe).not.toHaveBeenCalled()
  })

  it('reports undelivered when the session stream fails before a verdict', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    mocks.call.mockResolvedValue(sendAnswer(stagedEntry!.clientMessageId))
    mocks.subscribe.mockImplementation(async (_target, _params, _onEvent, onError) => {
      queueMicrotask(() => onError(new Error('stream closed')))
      return { unsubscribe: mocks.unsubscribe }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        options: { prompt: 'review this' },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: false, failureNotified: false })
  })
})
